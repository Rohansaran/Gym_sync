const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const pool = require('./db');
const session = require('express-session');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

app.use(session({
    secret: 'gymsync_secret',
    resave: false,
    saveUninitialized: false
}));

const PORT = process.env.PORT || 9000;

// ================= DB INIT =================
async function initDB() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE,
        password VARCHAR(100),
        total_points INT DEFAULT 0,
        level INT DEFAULT 1,
        reset_token VARCHAR(255),
        reset_token_expiry TIMESTAMP
    )`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
        user_id INT UNIQUE REFERENCES users(id),
        weight FLOAT,
        height FLOAT,
        fitness_goal VARCHAR(50)
    )`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS workouts (
        id SERIAL PRIMARY KEY,
        user_id INT,
        workout_name TEXT,
        duration INT,
        calories_burned INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS equipment (
        machine_id INT,
        unit_number INT,
        status VARCHAR(20),
        PRIMARY KEY(machine_id, unit_number)
    )`);

    await pool.query(`
    CREATE TABLE IF NOT EXISTS water_logs (
        id SERIAL PRIMARY KEY,
        user_id INT,
        amount FLOAT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
}
initDB();

// ================= AUTH =================

const checkAuth = (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ success: false });
    next();
};

app.post('/register', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await pool.query(
            "INSERT INTO users(username,password) VALUES($1,$2) RETURNING id",
            [username, password]
        );

        await pool.query(
            "INSERT INTO user_profiles(user_id,weight,height,fitness_goal) VALUES($1,70,170,'Weight Loss')",
            [user.rows[0].id]
        );

        res.json({ success: true });
    } catch {
        res.json({ success: false });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    const user = await pool.query(
        "SELECT * FROM users WHERE username=$1 AND password=$2",
        [username, password]
    );

    if (user.rows.length) {
        req.session.userId = user.rows[0].id;
        res.json({ success: true, username });
    } else res.json({ success: false });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ================= FORGOT PASSWORD =================

app.post('/forgot-password', async (req, res) => {
    const { username } = req.body;

    const user = await pool.query(
        "SELECT * FROM users WHERE username=$1",
        [username]
    );

    if (user.rows.length === 0) {
        return res.json({ success: false, message: "User not found" });
    }

    const token = crypto.randomBytes(32).toString('hex');

    await pool.query(
        `UPDATE users 
         SET reset_token=$1, reset_token_expiry=NOW() + INTERVAL '15 minutes'
         WHERE username=$2`,
        [token, username]
    );

    res.json({ success: true, token }); // demo purpose
});

app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    const user = await pool.query(
        `SELECT * FROM users 
         WHERE reset_token=$1 
         AND reset_token_expiry > NOW()`,
        [token]
    );

    if (user.rows.length === 0) {
        return res.json({ success: false });
    }

    await pool.query(
        `UPDATE users 
         SET password=$1, reset_token=NULL, reset_token_expiry=NULL
         WHERE reset_token=$2`,
        [newPassword, token]
    );

    res.json({ success: true });
});

// ================= PROFILE =================

app.get('/user-profile', checkAuth, async (req, res) => {
    const data = await pool.query(
        `SELECT u.username,u.total_points,u.level,up.*
         FROM users u
         JOIN user_profiles up ON u.id=up.user_id
         WHERE u.id=$1`,
        [req.session.userId]
    );

    res.json(data.rows[0]);
});

app.post('/update-profile', checkAuth, async (req, res) => {
    const { weight, height, fitness_goal } = req.body;

    await pool.query(
        `UPDATE user_profiles SET weight=$1,height=$2,fitness_goal=$3 WHERE user_id=$4`,
        [weight, height, fitness_goal, req.session.userId]
    );

    res.json({ success: true });
});

// ================= WORKOUT =================

app.post('/log-workout', checkAuth, async (req, res) => {
    const { workout_name, duration, calories_burned } = req.body;

    await pool.query(
        `INSERT INTO workouts(user_id,workout_name,duration,calories_burned)
         VALUES($1,$2,$3,$4)`,
        [req.session.userId, workout_name, duration, calories_burned]
    );

    await pool.query(
        `UPDATE users SET total_points = total_points + 10 WHERE id=$1`,
        [req.session.userId]
    );

    res.json({ success: true, pointsEarned: 10 });
});

app.get('/activity-history', checkAuth, async (req, res) => {
    const data = await pool.query(`
        SELECT DATE(created_at) as date,
        SUM(calories_burned) as total_calories
        FROM workouts
        WHERE user_id=$1
        GROUP BY DATE(created_at)
        ORDER BY date
    `, [req.session.userId]);

    res.json(data.rows);
});

// ================= LEADERBOARD =================

app.get('/leaderboard', async (req, res) => {
    const data = await pool.query(`
        SELECT username, total_points, level
        FROM users
        ORDER BY total_points DESC
        LIMIT 10
    `);

    res.json(data.rows);
});

// ================= WATER =================

app.post('/update-water', checkAuth, async (req, res) => {
    const { amount } = req.body;

    await pool.query(
        `INSERT INTO water_logs(user_id,amount) VALUES($1,$2)`,
        [req.session.userId, amount]
    );

    res.json({ success: true });
});

app.get('/water-today', checkAuth, async (req, res) => {
    const data = await pool.query(`
        SELECT SUM(amount) as total
        FROM water_logs
        WHERE user_id=$1
        AND DATE(created_at)=CURRENT_DATE
    `, [req.session.userId]);

    res.json({ total: data.rows[0].total || 0 });
});

// ================= MACHINE =================

app.post('/update-machine', async (req, res) => {
    const { id, unit, status } = req.body;

    await pool.query(`
        INSERT INTO equipment(machine_id,unit_number,status)
        VALUES($1,$2,$3)
        ON CONFLICT(machine_id,unit_number)
        DO UPDATE SET status=$3
    `, [id, unit, status]);

    io.emit('machine_status_changed', { machineId: id, unitNumber: unit, status });

    res.json({ success: true });
});

// ================= CHATBOT =================

app.post('/chatbot', (req, res) => {
    const msg = req.body.message.toLowerCase();

    let response = "Ask me about fitness!";

    if (msg.includes('protein')) response = "Eat eggs, chicken, paneer.";
    else if (msg.includes('weight')) response = "Calorie deficit + cardio.";
    else if (msg.includes('muscle')) response = "Lift heavy + protein.";

    res.json({ response });
});

// ================= NUTRITION =================

app.get('/nutrition/:food', async (req, res) => {
    try {
        const response = await axios.get('https://api.edamam.com/api/food-database/v2/parser', {
            params: {
                app_id: process.env.EDAMAM_APP_ID,
                app_key: process.env.EDAMAM_APP_KEY,
                ingr: req.params.food
            }
        });

        const food = response.data.hints[0].food;

        res.json({
            name: food.label,
            calories: food.nutrients.ENERC_KCAL || 100,
            protein: food.nutrients.PROCNT || 5,
            fat: food.nutrients.FAT || 2,
            carbs: food.nutrients.CHOCDF || 10
        });

    } catch {
        res.json({
            name: req.params.food,
            calories: 150,
            protein: 10,
            fat: 5,
            carbs: 20
        });
    }
});

// ================= SERVER =================

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
