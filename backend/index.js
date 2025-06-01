const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();
const port = 5000;
const axios = require('axios');
const multer = require('multer');
const path = require('path');


require('dotenv').config();
// Middleware
app.use(cors({
  origin: 'http://localhost:3000',
  methods: ['GET', 'POST', 'PUT' ,'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// MySQL connection pool
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'justice_platform',
  port: '3306',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test connection
pool.getConnection()
  .then(connection => {
    console.log('😁 Connected to MySQL database');
    connection.release();
  })
  .catch(err => {
    console.error('😒 Database connection error:', err);
  });


// Configure file storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Citizen contact endpoint
app.post('/api/contact/submit', async (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      subject,
      inquiryType,
      message,
      ipAddress,
      userAgent
    } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO citizen_contact_form 
      (full_name, email, phone, subject, inquiry_type, message, ip_address, user_agent) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [fullName, email, phone, subject, inquiryType, message, ipAddress || null, userAgent || null]
    );

    res.json({ success: true, message: 'تم إرسال النموذج بنجاح' });
  } catch (error) {
    console.error('Insert error:', error);
    res.status(500).json({ success: false, message: 'خطأ في الخادم. حاول مرة أخرى لاحقًا.' });
  }
});

//login
app.post('/api/employee/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [users] = await pool.execute(`
      SELECT 
        id, 
        username, 
        password, 
        role,
        full_name,
        full_name_ar,
        department,
        IFNULL(position, '') as position
      FROM employee_app_users 
      WHERE username = ?`, 
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'اسم المستخدم غير صحيح' });
    }
    
    const user = users[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
    }

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT secret is not configured');
    }

    const token = jwt.sign(
      { 
        userId: user.id,
        username: user.username,
        fullName: user.full_name,
        fullNameAr: user.full_name_ar,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    await pool.execute(
      'UPDATE employee_app_users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name || '',
        fullNameAr: user.full_name_ar || '',
        role: user.role,
        department: user.department || '',
        position: user.position || ''
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message || 'حدث خطأ في الخادم' 
    });
  }
});

// Employee current login 
app.get('/api/employee/current', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false });

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT secret is not configured');
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const [users] = await pool.execute(
      `SELECT 
        id, 
        username, 
        full_name, 
        full_name_ar,
        role,
        department,
        IFNULL(position, '') as position
       FROM employee_app_users 
       WHERE id = ?`,
      [decoded.userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ success: false });
    }

    res.json({ 
      success: true, 
      user: users[0] 
    });
  } catch (error) {
    console.error('Error fetching current user:', error);
    res.status(500).json({ 
      success: false,
      message: error.message 
    });
  }
});

// Chefs recommendations endpoint
app.get('/api/chefs/search', async (req, res) => {
  try {
    const { query } = req.query;
    let sql = 'SELECT id, full_name_ar, full_name_fr FROM chefs';
    let params = [];
    
    if (query) {
      sql += ' WHERE full_name_ar LIKE ? OR full_name_fr LIKE ? LIMIT 10';
      params = [`%${query}%`, `%${query}%`];
    } else {
      sql += ' LIMIT 50';
    }
    
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('Chefs search error:', err);
    res.status(500).json({ message: 'خطأ في البحث عن المسؤولين' });
  }
});

//Employees recommandations

app.get('/api/employees/search', async (req, res) => {
  try {
    const { query } = req.query;
    const [rows] = await pool.execute(
      `SELECT id, full_name_ar, full_name_fr FROM employees 
       WHERE full_name_ar LIKE ? OR full_name_fr LIKE ? LIMIT 10`,
      [`%${query}%`, `%${query}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('Employee search error:', err);
    res.status(500).json({ message: 'خطأ في البحث عن الموظفين' });
  }
});

//Supplies recommandations 
app.get('/api/supplies/search', async (req, res) => {
  try {
    const { query } = req.query;
    const [rows] = await pool.execute(
      `SELECT id, name_ar, name_en FROM office_supplies_catalog 
       WHERE name_ar LIKE ? OR name_en LIKE ? LIMIT 10`,
      [`%${query}%`, `%${query}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('Supplies search error:', err);
    res.status(500).json({ message: 'خطأ في البحث عن الأدوات المكتبية' });
  }
});

// Submit order
app.post('/api/orders/new', upload.any(), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    console.log('Request body:', req.body);
    console.log('Files:', req.files);

    const { notes, chefName } = req.body;
    const items = JSON.parse(req.body.items || '[]');

    if (!Array.isArray(items)) {
      return res.status(400).json({ 
        success: false,
        message: 'Items must be an array' 
      });
    }

    await conn.beginTransaction();

    // Generate order number
    const orderNumber = `ORD-${Date.now().toString().slice(-6)}`;
    
    // Insert main order - using requested_by_name for employee name
    const [orderResult] = await conn.execute(
      `INSERT INTO employee_office_orders 
       (order_number, requested_by_name, chef_name, notes) 
       VALUES (?, ?, ?, ?)`,
      [
        orderNumber,
        items[0]?.employeeName || 'غير معروف', // Employee name from first item
        chefName || null,
        notes || null
      ]
    );

    const orderId = orderResult.insertId;

    // Handle file uploads
    const files = req.files || [];
    const fileMap = {};
    files.forEach(file => {
      const match = file.fieldname.match(/proofFile_(\d+)/);
      if (match) {
        fileMap[match[1]] = file.path;
      }
    });

    // Insert items
    for (const [index, item] of items.entries()) {
      await conn.execute(
        `INSERT INTO order_items 
         (order_id, item_name, quantity, unit, employee_name, reason,
          is_new_employee, is_transferred, is_broken, proof_file_path, notes) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.name,
          item.quantity,
          item.unit || 'piece',
          item.employeeName || items[0]?.employeeName || 'غير معروف',
          item.reason || 'other',
          item.isNewEmployee ? 1 : 0,
          item.isTransferred ? 1 : 0,
          item.isBroken ? 1 : 0,
          fileMap[index] || null,
          item.notes || null
        ]
      );
    }

    await conn.commit();
    
    res.json({ 
      success: true, 
      message: 'تم تقديم الطلب بنجاح',
      orderNumber 
    });

  } catch (error) {
    await conn.rollback();
    console.error('Order submission error:', error);
    res.status(500).json({ 
      success: false,
      message: error.message || 'فشل في تقديم الطلب'
    });
  } finally {
    conn.release();
  }
});

// Get all orders
app.get('/api/orders', async (req, res) => {
  try {
    const [orders] = await pool.execute(`
      SELECT 
        o.id,
        o.order_number,
        o.requested_by_name AS employee_name,
        o.chef_name,
        DATE_FORMAT(o.order_date, '%Y-%m-%d %H:%i:%s') AS order_date,
        o.status,
        o.notes,
        GROUP_CONCAT(i.item_name SEPARATOR ', ') AS items_list,
        COUNT(i.id) AS items_count
      FROM 
        employee_office_orders o
      LEFT JOIN 
        order_items i ON o.id = i.order_id
      GROUP BY o.id
      ORDER BY o.order_date DESC
    `);

    // Map status to Arabic
    const statusMap = {
      'pending': 'قيد المعالجة',
      'approved': 'تم الموافقة', 
      'rejected': 'تم الرفض',
      'fulfilled': 'تم التسليم'
    };

    const formattedOrders = orders.map(order => ({
      ...order,
      status: statusMap[order.status] || order.status,
      order_date: new Date(order.order_date).toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    }));

    res.json(formattedOrders);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ 
      success: false,
      message: 'فشل في جلب الطلبات',
      error: err.message  
    });
  }
});

//  order status endpoint
app.put('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ 
      success: false,
      message: 'يجب توفير الحالة الجديدة' 
    });
  }

  // Reverse mapping for status
  const statusMap = {
    'قيد المعالجة': 'pending',
    'تم الموافقة': 'approved',
    'تم الرفض': 'rejected',
    'تم التسليم': 'fulfilled'
  };

  const dbStatus = statusMap[status] || status;

  try {
    const [result] = await pool.execute(
      'UPDATE employee_office_orders SET status = ? WHERE id = ?',
      [dbStatus, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'لم يتم العثور على الطلب' 
      });
    }

    res.json({ 
      success: true, 
      message: 'تم تحديث الحالة بنجاح',
      newStatus: status
    });
  } catch (err) {
    console.error("Error updating order status:", err);
    res.status(500).json({ 
      success: false,
      message: 'فشل في تحديث الحالة',
      error: err.message
    });
  }
});

// Employee rating endpoint
app.post('/api/employee/rating', async (req, res) => {
  try {
    const { rating, comment } = req.body;

    if (typeof rating !== 'number' || isNaN(rating)) {
      return res.status(400).json({
        success: false,
        message: 'التقييم يجب أن يكون رقماً'
      });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'يجب أن يكون التقييم بين 1 و 5'
      });
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const [result] = await pool.execute(
      `INSERT INTO employee_ratings (rating, comment, ip_address, user_agent)
       VALUES (?, ?, ?, ?)`,
      [rating, comment || null, ipAddress || null, userAgent || null]
    );

    res.json({ 
      success: true, 
      message: 'تم إرسال التقييم بنجاح' 
    });
  } catch (error) {
    console.error('Rating submission error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'خطأ في الخادم. حاول مرة أخرى لاحقًا.' 
    });
  }
});


//chatbot


// Start server
app.listen(port, () => {
  console.log(` 😜 Server running on http://localhost:${port}`);
});