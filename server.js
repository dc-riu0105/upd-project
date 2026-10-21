const express = require('express');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= CẤU HÌNH HỆ THỐNG =================
const BOT_TOKEN = 'THAY_BOT_TOKEN_CUA_BAN_VAO_DAY'; 
const WEBHOOK_SECRET_KEY = 'MAT_KHAU_BAO_MAT_WEBHOOK_NGAN_HANG'; // Dùng để bảo mật API nạp tiền

// ================= KHỞI TẠO DATABASE (SQLite) =================
const db = new sqlite3.Database('./shop.db');

db.serialize(() => {
    // 1. Bảng người dùng
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        balance INTEGER DEFAULT 0
    )`);

    // 2. Bảng sản phẩm
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        price INTEGER,
        stock INTEGER,
        image TEXT
    )`);

    // 3. Bảng đơn hàng
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER,
        product_id INTEGER,
        account_delivered TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Thêm dữ liệu sản phẩm mẫu giống trong ảnh nếu bảng trống
    db.get("SELECT COUNT(*) as count FROM products", (err, row) => {
        if (row.count === 0) {
            db.run(`INSERT INTO products (name, price, stock, image) VALUES 
                ('Locket Gold 1 năm', 35678, 91, 'https://placehold.co/300x200/1e293b/ffffff?text=Locket+Gold'),
                ('Gemini 18 Months', 16666, 78, 'https://placehold.co/300x200/1e293b/38bdf8?text=Google+AI+Pro')
            `);
        }
    });
});

// ================= BƯỚC 3: HÀM XÁC THỰC BẢO MẬT TELEGRAM =================
function verifyTelegramWebAppData(telegramInitData) {
    if (!telegramInitData) return null;
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    // Sắp xếp các tham số theo thứ tự bảng chữ cái
    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    // Tạo khóa bí mật từ BOT_TOKEN
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calculatedHash === hash) {
        return JSON.parse(urlParams.get('user'));
    }
    return null;
}

// ================= API XÁC THỰC & LẤY DỮ LIỆU SHOP =================
app.post('/api/auth', (req, res) => {
    const { initData, fallbackUser } = req.body;
    
    // Xác thực chữ ký Telegram (Nếu chạy test trên trình duyệt thường thì dùng fallbackUser)
    const verifiedUser = verifyTelegramWebAppData(initData) || fallbackUser;
    if (!verifiedUser || !verifiedUser.id) {
        return res.status(401).json({ success: false, message: 'Xác thực không hợp lệ!' });
    }

    const userId = verifiedUser.id;
    const username = verifiedUser.username || 'unknown';

    // Lưu user mới vào DB nếu chưa tồn tại
    db.run(`INSERT OR IGNORE INTO users (telegram_id, username, balance) VALUES (?, ?, 0)`, [userId, username], () => {
        db.get(`SELECT * FROM users WHERE telegram_id = ?`, [userId], (err, userRow) => {
            db.all(`SELECT * FROM products`, [], (err, products) => {
                res.json({ success: true, user: userRow, products });
            });
        });
    });
});

// ================= API MUA HÀNG TỰ ĐỘNG =================
app.post('/api/buy', (req, res) => {
    const { initData, userId, productId } = req.body;
    const verifiedUser = verifyTelegramWebAppData(initData);
    const activeUserId = verifiedUser ? verifiedUser.id : userId;

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [activeUserId], (err, user) => {
        db.get(`SELECT * FROM products WHERE id = ?`, [productId], (err, product) => {
            if (!product || product.stock <= 0) {
                return res.json({ success: false, message: 'Sản phẩm đã hết hàng!' });
            }
            if (!user || user.balance < product.price) {
                return res.json({ success: false, message: 'Số dư không đủ, vui lòng nạp thêm!' });
            }

            const newBalance = user.balance - product.price;
            const fakeAccountData = `TK: user_${Math.floor(Math.random()*1000)}@gmail.com | MK: 12345678`;

            // Trừ tiền, trừ kho và lưu lịch sử đơn hàng
            db.serialize(() => {
                db.run(`UPDATE users SET balance = ? WHERE telegram_id = ?`, [newBalance, activeUserId]);
                db.run(`UPDATE products SET stock = stock - 1 WHERE id = ?`, [productId]);
                db.run(`INSERT INTO orders (telegram_id, product_id, account_delivered) VALUES (?, ?, ?)`, 
                    [activeUserId, productId, fakeAccountData]);

                // Gửi tin nhắn tài khoản về khung chat Telegram của khách
                sendTelegramMessage(activeUserId, `✅ *Đơn hàng thành công!*\nSản phẩm: ${product.name}\nThông tin: \`${fakeAccountData}\``);

                res.json({ success: true, newBalance, accountData: fakeAccountData });
            });
        });
    });
});

// ================= BƯỚC 4: WEBHOOK NẠP TIỀN TỰ ĐỘNG (SEPAY / CASSO) =================
app.post('/api/webhook/bank', (req, res) => {
    // 1. Kiểm tra bảo mật Webhook (Tránh kẻ gian gửi request giả cộng tiền)
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Apikey ${WEBHOOK_SECRET_KEY}`) {
        return res.status(403).json({ success: false, message: 'Unauthorized Webhook' });
    }

    // 2. Lấy dữ liệu giao dịch ngân hàng gửi về (Chuẩn định dạng SePay/Casso)
    const { content, transferAmount } = req.body; 
    // Ví dụ content: "MBVCB.12345.NAP 5637124894.CT tu..."
    
    if (!content || !transferAmount) {
        return res.status(400).json({ success: false });
    }

    // 3. Dùng Regex tách Telegram ID từ nội dung chuyển khoản "NAP <ID>"
    const match = content.match(/NAP\s*(\d+)/i);
    if (match && match[1]) {
        const telegramId = parseInt(match[1], 10);
        const amount = parseInt(transferAmount, 10);

        // 4. Cộng tiền vào Database
        db.run(`UPDATE users SET balance = balance + ? WHERE telegram_id = ?`, [amount, telegramId], function(err) {
            if (this.changes > 0) {
                // Gửi thông báo qua Bot Telegram
                sendTelegramMessage(
                    telegramId, 
                    `💰 *Nạp tiền thành công!*\nSố tiền: +${amount.toLocaleString('vi-VN')}đ\nCảm ơn bạn đã sử dụng dịch vụ!`
                );
            }
        });
    }

    // Luôn trả về 200 OK để cổng thanh toán biết đã nhận Webhook
    res.status(200).json({ success: true });
});

// Hàm hỗ trợ gửi tin nhắn qua Telegram Bot API
function sendTelegramMessage(chatId, text) {
    if (BOT_TOKEN === 'THAY_BOT_TOKEN_CUA_BAN_VAO_DAY') return;
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
    }).catch(err => console.error("Lỗi gửi tin nhắn Telegram:", err));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
