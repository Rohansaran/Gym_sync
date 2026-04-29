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
        fitness_goal VARCHAR(50),
        diet_preference VARCHAR(20) DEFAULT 'non-veg'
    )`);

    // Add column if table already exists (for existing databases)
    await pool.query(`
        ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS diet_preference VARCHAR(20) DEFAULT 'non-veg'
    `);

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

    await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        trainer VARCHAR(100),
        time VARCHAR(50),
        capacity INT DEFAULT 20,
        booked INT DEFAULT 0
    )`);

    // Seed default classes if table is empty
    const classCount = await pool.query(`SELECT COUNT(*) FROM classes`);
    if (parseInt(classCount.rows[0].count) === 0) {
        await pool.query(`
            INSERT INTO classes (name, trainer, time, capacity, booked) VALUES
            ('💪 Power Yoga', 'Ananya Sharma', 'Mon & Wed 7:00 AM', 20, 8),
            ('🔥 HIIT Blast', 'Rahul Verma', 'Tue & Thu 6:30 AM', 15, 12),
            ('🏋️ Strength & Conditioning', 'Vikram Singh', 'Mon Wed Fri 5:30 PM', 18, 6),
            ('🧘 Morning Meditation', 'Priya Nair', 'Daily 6:00 AM', 25, 15),
            ('🚴 Spin Cycle', 'Arjun Kapoor', 'Tue Thu Sat 7:30 AM', 16, 9),
            ('🥊 Kickboxing', 'Deepak Rawat', 'Wed & Fri 6:00 PM', 14, 5)
        `);
    }
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

    res.json({ success: true, token });
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
    const { weight, height, fitness_goal, diet_preference } = req.body;

    await pool.query(
        `UPDATE user_profiles SET weight=$1,height=$2,fitness_goal=$3,diet_preference=$4 WHERE user_id=$5`,
        [weight, height, fitness_goal, diet_preference || 'non-veg', req.session.userId]
    );

    res.json({ success: true });
});

// ================= WORKOUT =================

const workoutPlans = {
    'weight loss': {
        name: '🔥 Fat Burn Circuit',
        duration: 40,
        caloriesPerMin: 10,
        exercises: `WARM UP (5 min)
• Jumping Jacks — 2 min
• High Knees — 2 min
• Arm Circles — 1 min

CIRCUIT (3 rounds, 30s rest between rounds)
1. Burpees — 15 reps
2. Jump Squats — 20 reps
3. Mountain Climbers — 30 reps
4. Push-Ups — 15 reps
5. Reverse Lunges — 20 reps (10 each leg)
6. Plank Hold — 45 seconds

CARDIO BLAST (10 min)
• Jump Rope / Spot Jogging — 5 min
• Sprint Intervals (30s on / 30s off) — 5 min

COOL DOWN (5 min)
• Standing Quad Stretch — 1 min
• Hamstring Stretch — 1 min
• Child's Pose — 1 min
• Deep Breathing — 2 min`
    },
    'muscle gain': {
        name: '💪 Hypertrophy Power Session',
        duration: 60,
        caloriesPerMin: 8,
        exercises: `WARM UP (5 min)
• Dynamic Stretching — 2 min
• Resistance Band Pull-Aparts — 3 min

PUSH DAY — Chest / Shoulders / Triceps
1. Bench Press — 4 sets × 8 reps
2. Incline Dumbbell Press — 3 sets × 10 reps
3. Overhead Shoulder Press — 4 sets × 8 reps
4. Lateral Raises — 3 sets × 12 reps
5. Tricep Dips — 3 sets × 12 reps
6. Cable Tricep Pushdown — 3 sets × 15 reps

(Rest 60–90 sec between sets)

FINISHER
• Push-Up Burnout — max reps × 2 sets

COOL DOWN (5 min)
• Chest Doorframe Stretch — 1 min
• Overhead Tricep Stretch — 1 min
• Shoulder Cross-Body Stretch — 1 min
• Foam Roll Upper Back — 2 min`
    },
    'endurance': {
        name: '🏃 Endurance Builder',
        duration: 50,
        caloriesPerMin: 9,
        exercises: `WARM UP (5 min)
• Light Jog — 3 min
• Leg Swings & Hip Circles — 2 min

STEADY STATE CARDIO (20 min)
• Treadmill / Outdoor Run at 65–70% Max HR
  Target Pace: Conversational (can talk but slightly breathless)

INTERVAL TRAINING (15 min)
• 5 rounds:
  — Fast Run / Cycle: 90 seconds
  — Active Recovery Walk: 60 seconds

BODYWEIGHT CIRCUIT (2 rounds)
1. Step-Ups — 20 reps
2. Box Jumps (or Jump Squats) — 15 reps
3. Bear Crawls — 20 metres
4. Lateral Shuffles — 30 seconds
5. Calf Raises — 30 reps

COOL DOWN (5 min)
• Standing Calf Stretch — 1 min
• Hip Flexor Stretch — 1 min each side
• Seated Forward Fold — 1 min
• Diaphragmatic Breathing — 1 min`
    },
    'strength': {
        name: '⚡ Max Strength Session',
        duration: 60,
        caloriesPerMin: 7,
        exercises: `WARM UP (5 min)
• Hip Hinges — 15 reps
• Goblet Squats (light) — 10 reps
• Band Walks — 2 min

COMPOUND LIFTS — Lower Body Focus
1. Back Squat — 5 sets × 5 reps (heavy)
2. Romanian Deadlift — 4 sets × 6 reps
3. Leg Press — 3 sets × 8 reps
4. Walking Lunges — 3 sets × 12 reps

ACCESSORY WORK
5. Leg Curl (Machine) — 3 sets × 12 reps
6. Leg Extension — 3 sets × 12 reps
7. Standing Calf Raises — 4 sets × 15 reps

(Rest 2–3 min between compound sets)

CORE FINISHER
• Deadbug — 3 sets × 10 reps
• Pallof Press — 3 sets × 12 reps

COOL DOWN (5 min)
• Pigeon Pose — 1 min each side
• Seated Hamstring Stretch — 1 min
• Foam Roll Quads & IT Band — 2 min`
    }
};

app.get('/workout-plans', checkAuth, async (req, res) => {
    const goal = (req.query.goal || 'muscle gain').toLowerCase()
        .replace('🔥 ', '').replace('💪 ', '').replace('🏃 ', '').replace('⚡ ', '');

    const plan = workoutPlans[goal] || workoutPlans['muscle gain'];
    res.json([{ name: plan.name, exercises: plan.exercises, duration: plan.duration, caloriesPerMin: plan.caloriesPerMin }]);
});

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
    // Always return last 7 days, filling missing days with 0
    const data = await pool.query(`
        SELECT DATE(created_at) as date,
        SUM(calories_burned) as total_calories
        FROM workouts
        WHERE user_id=$1
        AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY DATE(created_at)
        ORDER BY date
    `, [req.session.userId]);

    // Build a full 7-day map with 0s for missing days
    const result = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const found = data.rows.find(r => {
            const rd = new Date(r.date);
            return rd.toISOString().split('T')[0] === dateStr;
        });
        result.push({
            date: d.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' }),
            total_calories: found ? parseInt(found.total_calories) : 0
        });
    }

    res.json(result);
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

// ================= CLASSES =================

app.get('/classes', async (req, res) => {
    try {
        const data = await pool.query(`
            SELECT id, name, trainer, time, capacity, booked
            FROM classes
            ORDER BY id
        `);
        res.json(data.rows);
    } catch (err) {
        console.error('Failed to fetch classes:', err);
        res.status(500).json([]);
    }
});

app.post('/book-class', checkAuth, async (req, res) => {
    const { class_id } = req.body;
    try {
        const cls = await pool.query(`SELECT * FROM classes WHERE id=$1`, [class_id]);
        if (!cls.rows.length) return res.json({ success: false, message: 'Class not found' });
        if (cls.rows[0].booked >= cls.rows[0].capacity)
            return res.json({ success: false, message: 'Class is full' });

        await pool.query(`UPDATE classes SET booked = booked + 1 WHERE id=$1`, [class_id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Failed to book class:', err);
        res.status(500).json({ success: false });
    }
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

app.post('/chatbot', checkAuth, async (req, res) => {
    const userMessage = req.body.message;
    if (!userMessage) return res.json({ response: "Please ask me something!" });

    // Get user profile for context
    let profileContext = '';
    try {
        const profile = await pool.query(
            `SELECT up.weight, up.height, up.fitness_goal, up.diet_preference
             FROM user_profiles up WHERE up.user_id=$1`,
            [req.session.userId]
        );
        if (profile.rows.length) {
            const p = profile.rows[0];
            const bmi = p.weight && p.height
                ? (p.weight / ((p.height / 100) ** 2)).toFixed(1)
                : null;
            profileContext = `User profile: Weight ${p.weight}kg, Height ${p.height}cm, BMI ${bmi}, Goal: ${p.fitness_goal}, Diet: ${p.diet_preference}.`;
        }
    } catch {}

    try {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 300,
                system: `You are an expert AI Fitness Coach inside GymSync PRO, a fitness tracking app. 
You give concise, accurate, motivating advice on workouts, nutrition, recovery, and fitness goals.
Keep responses under 100 words. Be direct, practical, and encouraging.
${profileContext}
Always tailor advice to the user's profile when relevant.`,
                messages: [{ role: 'user', content: userMessage }]
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                }
            }
        );

        const reply = response.data.content[0].text;
        res.json({ response: reply });

    } catch (err) {
        // Fallback to smart keyword responses if API fails
        const msg = userMessage.toLowerCase();
        let response = "Great question! Focus on consistency — small daily improvements lead to big results. 💪";

        if (msg.includes('protein'))       response = "Aim for 1.6–2.2g protein per kg of bodyweight daily. Best sources: eggs, chicken, paneer, dal, whey protein.";
        else if (msg.includes('weight loss') || msg.includes('lose weight')) response = "Create a 300–500 kcal daily deficit. Combine cardio (3x/week) with strength training. Prioritize sleep and protein.";
        else if (msg.includes('muscle') || msg.includes('bulk')) response = "Progressive overload is key. Lift heavier each week, eat 200–300 kcal surplus, sleep 8hrs, hit 2g protein/kg.";
        else if (msg.includes('cardio'))   response = "Mix steady-state cardio (fat burn) with HIIT (calorie blast). 3–4x per week is ideal. Don't skip warm-up!";
        else if (msg.includes('sleep'))    response = "Sleep is when muscles grow! Aim for 7–9 hours. Poor sleep raises cortisol, kills gains, and increases hunger.";
        else if (msg.includes('water') || msg.includes('hydration')) response = "Drink at least 35ml per kg bodyweight daily. More on workout days. Dehydration drops performance by 10–20%.";
        else if (msg.includes('creatine')) response = "Creatine monohydrate is the most researched supplement. 5g/day improves strength, power, and muscle recovery. Safe long-term.";
        else if (msg.includes('beginner')) response = "Start with 3 full-body sessions/week. Master squat, hinge, push, pull, carry. Add cardio 2x. Progress before adding more.";
        else if (msg.includes('diet') || msg.includes('food') || msg.includes('eat')) response = "80% whole foods: lean protein, complex carbs, healthy fats, lots of veggies. 20% flexibility. Consistency > perfection.";
        else if (msg.includes('motivation')) response = "On hard days, remember WHY you started. Progress is never linear — every rep counts. Show up even when it's 20%. 🔥";

        res.json({ response });
    }
});

// ================= NUTRITION =================
// Accurate per-100g nutritional database (USDA / standard values)
const foodDatabase = {
    // Fruits
    'apple':        { calories: 52,  protein: 0.3, fat: 0.2, carbs: 14.0 },
    'banana':       { calories: 89,  protein: 1.1, fat: 0.3, carbs: 23.0 },
    'orange':       { calories: 47,  protein: 0.9, fat: 0.1, carbs: 12.0 },
    'mango':        { calories: 60,  protein: 0.8, fat: 0.4, carbs: 15.0 },
    'grapes':       { calories: 69,  protein: 0.7, fat: 0.2, carbs: 18.0 },
    'strawberry':   { calories: 32,  protein: 0.7, fat: 0.3, carbs: 7.7  },
    'watermelon':   { calories: 30,  protein: 0.6, fat: 0.2, carbs: 7.6  },
    'pineapple':    { calories: 50,  protein: 0.5, fat: 0.1, carbs: 13.0 },
    'papaya':       { calories: 43,  protein: 0.5, fat: 0.3, carbs: 11.0 },
    'guava':        { calories: 68,  protein: 2.6, fat: 1.0, carbs: 14.0 },
    'pomegranate':  { calories: 83,  protein: 1.7, fat: 1.2, carbs: 19.0 },
    'avocado':      { calories: 160, protein: 2.0, fat: 15.0, carbs: 9.0 },
    'kiwi':         { calories: 61,  protein: 1.1, fat: 0.5, carbs: 15.0 },
    'lemon':        { calories: 29,  protein: 1.1, fat: 0.3, carbs: 9.3  },
    'dates':        { calories: 277, protein: 1.8, fat: 0.2, carbs: 75.0 },

    // Vegetables
    'spinach':      { calories: 23,  protein: 2.9, fat: 0.4, carbs: 3.6  },
    'broccoli':     { calories: 34,  protein: 2.8, fat: 0.4, carbs: 7.0  },
    'carrot':       { calories: 41,  protein: 0.9, fat: 0.2, carbs: 10.0 },
    'tomato':       { calories: 18,  protein: 0.9, fat: 0.2, carbs: 3.9  },
    'potato':       { calories: 77,  protein: 2.0, fat: 0.1, carbs: 17.0 },
    'sweet potato': { calories: 86,  protein: 1.6, fat: 0.1, carbs: 20.0 },
    'onion':        { calories: 40,  protein: 1.1, fat: 0.1, carbs: 9.3  },
    'cucumber':     { calories: 16,  protein: 0.7, fat: 0.1, carbs: 3.6  },
    'capsicum':     { calories: 31,  protein: 1.0, fat: 0.3, carbs: 6.0  },
    'cauliflower':  { calories: 25,  protein: 2.0, fat: 0.3, carbs: 5.0  },
    'cabbage':      { calories: 25,  protein: 1.3, fat: 0.1, carbs: 5.8  },
    'mushroom':     { calories: 22,  protein: 3.1, fat: 0.3, carbs: 3.3  },
    'peas':         { calories: 81,  protein: 5.4, fat: 0.4, carbs: 14.0 },
    'corn':         { calories: 86,  protein: 3.3, fat: 1.4, carbs: 19.0 },
    'pumpkin':      { calories: 26,  protein: 1.0, fat: 0.1, carbs: 6.5  },

    // Grains & Carbs
    'rice':         { calories: 130, protein: 2.7, fat: 0.3, carbs: 28.0 },
    'brown rice':   { calories: 123, protein: 2.6, fat: 0.9, carbs: 26.0 },
    'oats':         { calories: 389, protein: 17.0, fat: 7.0, carbs: 66.0 },
    'wheat':        { calories: 340, protein: 13.0, fat: 2.5, carbs: 71.0 },
    'roti':         { calories: 297, protein: 9.0, fat: 3.7, carbs: 57.0 },
    'bread':        { calories: 265, protein: 9.0, fat: 3.2, carbs: 51.0 },
    'pasta':        { calories: 131, protein: 5.0, fat: 1.1, carbs: 25.0 },
    'quinoa':       { calories: 120, protein: 4.4, fat: 1.9, carbs: 22.0 },
    'poha':         { calories: 350, protein: 6.5, fat: 2.6, carbs: 77.0 },
    'idli':         { calories: 58,  protein: 2.0, fat: 0.4, carbs: 12.0 },
    'dosa':         { calories: 168, protein: 3.8, fat: 6.4, carbs: 25.0 },

    // Proteins - Meat & Fish
    'chicken':          { calories: 165, protein: 31.0, fat: 3.6, carbs: 0.0 },
    'chicken breast':   { calories: 165, protein: 31.0, fat: 3.6, carbs: 0.0 },
    'egg':              { calories: 155, protein: 13.0, fat: 11.0, carbs: 1.1 },
    'eggs':             { calories: 155, protein: 13.0, fat: 11.0, carbs: 1.1 },
    'fish':             { calories: 136, protein: 22.0, fat: 5.0, carbs: 0.0 },
    'salmon':           { calories: 208, protein: 20.0, fat: 13.0, carbs: 0.0 },
    'tuna':             { calories: 132, protein: 28.0, fat: 1.3, carbs: 0.0 },
    'mutton':           { calories: 294, protein: 25.0, fat: 21.0, carbs: 0.0 },
    'beef':             { calories: 250, protein: 26.0, fat: 17.0, carbs: 0.0 },
    'prawn':            { calories: 99,  protein: 21.0, fat: 1.7, carbs: 0.0 },
    'shrimp':           { calories: 99,  protein: 21.0, fat: 1.7, carbs: 0.0 },

    // Proteins - Veg
    'paneer':       { calories: 265, protein: 18.0, fat: 20.0, carbs: 3.4 },
    'tofu':         { calories: 76,  protein: 8.0,  fat: 4.5,  carbs: 1.9 },
    'dal':          { calories: 116, protein: 9.0,  fat: 0.4,  carbs: 20.0 },
    'lentils':      { calories: 116, protein: 9.0,  fat: 0.4,  carbs: 20.0 },
    'rajma':        { calories: 127, protein: 8.7,  fat: 0.5,  carbs: 22.0 },
    'kidney beans': { calories: 127, protein: 8.7,  fat: 0.5,  carbs: 22.0 },
    'chickpeas':    { calories: 164, protein: 8.9,  fat: 2.6,  carbs: 27.0 },
    'chana':        { calories: 164, protein: 8.9,  fat: 2.6,  carbs: 27.0 },
    'soybean':      { calories: 173, protein: 17.0, fat: 9.0,  carbs: 10.0 },
    'moong dal':    { calories: 105, protein: 7.0,  fat: 0.4,  carbs: 18.0 },
    'masoor dal':   { calories: 116, protein: 9.0,  fat: 0.4,  carbs: 20.0 },

    // Dairy
    'milk':         { calories: 61,  protein: 3.2, fat: 3.3, carbs: 4.8 },
    'curd':         { calories: 98,  protein: 11.0, fat: 4.3, carbs: 3.4 },
    'yogurt':       { calories: 59,  protein: 10.0, fat: 0.4, carbs: 3.6 },
    'butter':       { calories: 717, protein: 0.9, fat: 81.0, carbs: 0.1 },
    'ghee':         { calories: 900, protein: 0.0, fat: 100.0, carbs: 0.0 },
    'cheese':       { calories: 402, protein: 25.0, fat: 33.0, carbs: 1.3 },
    'whey protein': { calories: 400, protein: 80.0, fat: 5.0, carbs: 10.0 },

    // Nuts & Seeds
    'almonds':      { calories: 579, protein: 21.0, fat: 50.0, carbs: 22.0 },
    'walnuts':      { calories: 654, protein: 15.0, fat: 65.0, carbs: 14.0 },
    'peanuts':      { calories: 567, protein: 26.0, fat: 49.0, carbs: 16.0 },
    'cashews':      { calories: 553, protein: 18.0, fat: 44.0, carbs: 30.0 },
    'peanut butter':{ calories: 588, protein: 25.0, fat: 50.0, carbs: 20.0 },
    'chia seeds':   { calories: 486, protein: 17.0, fat: 31.0, carbs: 42.0 },
    'flaxseeds':    { calories: 534, protein: 18.0, fat: 42.0, carbs: 29.0 },
    'sunflower seeds':{ calories: 584, protein: 21.0, fat: 51.0, carbs: 20.0 },

    // Oils & Fats
    'olive oil':    { calories: 884, protein: 0.0, fat: 100.0, carbs: 0.0 },
    'coconut oil':  { calories: 862, protein: 0.0, fat: 100.0, carbs: 0.0 },

    // Drinks
    'coconut water':{ calories: 19,  protein: 0.7, fat: 0.2, carbs: 3.7 },
    'orange juice': { calories: 45,  protein: 0.7, fat: 0.2, carbs: 10.0 },
    'whole milk':   { calories: 61,  protein: 3.2, fat: 3.3, carbs: 4.8 },

    // Snacks / Other
    'dark chocolate':{ calories: 546, protein: 5.0, fat: 31.0, carbs: 60.0 },
    'honey':        { calories: 304, protein: 0.3, fat: 0.0, carbs: 82.0 },
    'sugar':        { calories: 387, protein: 0.0, fat: 0.0, carbs: 100.0 },
    'granola':      { calories: 471, protein: 10.0, fat: 20.0, carbs: 64.0 },
};

function findFood(query) {
    const q = query.toLowerCase().trim();

    // 1. Exact match
    if (foodDatabase[q]) return { key: q, ...foodDatabase[q] };

    // 2. Starts-with match
    const startMatch = Object.keys(foodDatabase).find(k => k.startsWith(q) || q.startsWith(k));
    if (startMatch) return { key: startMatch, ...foodDatabase[startMatch] };

    // 3. Contains match
    const containsMatch = Object.keys(foodDatabase).find(k => k.includes(q) || q.includes(k));
    if (containsMatch) return { key: containsMatch, ...foodDatabase[containsMatch] };

    return null;
}

app.get('/nutrition/:food', async (req, res) => {
    const query = decodeURIComponent(req.params.food).toLowerCase().trim();
    const match = findFood(query);

    if (match) {
        return res.json({
            name: query.charAt(0).toUpperCase() + query.slice(1),
            calories: Math.round(match.calories),
            protein: Math.round(match.protein * 10) / 10,
            fat:     Math.round(match.fat * 10) / 10,
            carbs:   Math.round(match.carbs * 10) / 10,
            per: '100g'
        });
    }

    // Fallback: try Edamam API
    try {
        const response = await axios.get('https://api.edamam.com/api/food-database/v2/parser', {
            params: {
                app_id: process.env.EDAMAM_APP_ID,
                app_key: process.env.EDAMAM_APP_KEY,
                ingr: query
            }
        });
        const food = response.data.hints[0].food;
        return res.json({
            name: food.label,
            calories: Math.round(food.nutrients.ENERC_KCAL || 0),
            protein:  Math.round((food.nutrients.PROCNT  || 0) * 10) / 10,
            fat:      Math.round((food.nutrients.FAT      || 0) * 10) / 10,
            carbs:    Math.round((food.nutrients.CHOCDF   || 0) * 10) / 10,
            per: '100g'
        });
    } catch {
        return res.json({ success: false, message: `"${query}" not found in database. Try a common food name.` });
    }
});

// ================= DIET RECOMMENDATION =================

app.get('/diet-recommendation', checkAuth, async (req, res) => {
    const data = await pool.query(
        `SELECT weight, height, fitness_goal, diet_preference FROM user_profiles WHERE user_id=$1`,
        [req.session.userId]
    );

    if (!data.rows.length || !data.rows[0].weight || !data.rows[0].height) {
        return res.json({ success: false, message: "Profile not complete" });
    }

    const { weight, height, fitness_goal, diet_preference } = data.rows[0];
    const isVeg = (diet_preference || 'non-veg') === 'veg';

    const heightM = height / 100;
    const bmi = parseFloat((weight / (heightM * heightM)).toFixed(1));

    let bmiCategory;
    if (bmi < 18.5) bmiCategory = 'underweight';
    else if (bmi < 25) bmiCategory = 'normal';
    else if (bmi < 30) bmiCategory = 'overweight';
    else bmiCategory = 'obese';

    const bmr = 10 * weight + 6.25 * height - 5 * 25 + 5;
    const tdee = Math.round(bmr * 1.55);

    let calorieTarget, proteinTarget, carbTarget, fatTarget, goalLabel;
    const goal = fitness_goal ? fitness_goal.toLowerCase() : '';

    if (goal.includes('weight loss') || goal.includes('lose')) {
        calorieTarget = tdee - 500;
        proteinTarget = Math.round(weight * 2.0);
        fatTarget = Math.round((calorieTarget * 0.25) / 9);
        carbTarget = Math.round((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4);
        goalLabel = 'Weight Loss';
    } else if (goal.includes('muscle') || goal.includes('gain')) {
        calorieTarget = tdee + 300;
        proteinTarget = Math.round(weight * 2.2);
        fatTarget = Math.round((calorieTarget * 0.25) / 9);
        carbTarget = Math.round((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4);
        goalLabel = 'Muscle Gain';
    } else if (goal.includes('endurance')) {
        calorieTarget = tdee + 100;
        proteinTarget = Math.round(weight * 1.6);
        fatTarget = Math.round((calorieTarget * 0.20) / 9);
        carbTarget = Math.round((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4);
        goalLabel = 'Endurance';
    } else if (goal.includes('strength')) {
        calorieTarget = tdee + 200;
        proteinTarget = Math.round(weight * 2.0);
        fatTarget = Math.round((calorieTarget * 0.30) / 9);
        carbTarget = Math.round((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4);
        goalLabel = 'Strength';
    } else {
        calorieTarget = tdee;
        proteinTarget = Math.round(weight * 1.8);
        fatTarget = Math.round((calorieTarget * 0.28) / 9);
        carbTarget = Math.round((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4);
        goalLabel = 'Maintenance';
    }

    // ---- VEG MEAL PLANS ----
    const vegMealPlans = {
        weight_loss: {
            breakfast: [
                { name: "Oats with chia seeds, banana & almonds", calories: 310, protein: 11, carbs: 50, fat: 7, emoji: "🥣" },
                { name: "Moong dal chilla + green chutney", calories: 280, protein: 16, carbs: 38, fat: 5, emoji: "🫓" }
            ],
            lunch: [
                { name: "Mixed veg salad + low-fat paneer (50g) + 2 roti", calories: 370, protein: 18, carbs: 48, fat: 10, emoji: "🥗" },
                { name: "Moong dal soup + brown rice (small) + raita", calories: 380, protein: 20, carbs: 55, fat: 7, emoji: "🍲" }
            ],
            dinner: [
                { name: "Palak paneer (less oil) + 1 roti + salad", calories: 340, protein: 22, carbs: 28, fat: 14, emoji: "🥬" },
                { name: "Masoor dal + steamed veggies + 1 roti", calories: 320, protein: 18, carbs: 42, fat: 6, emoji: "🫘" }
            ],
            snacks: [
                { name: "Apple + 10 walnuts", calories: 155, protein: 3, carbs: 22, fat: 9, emoji: "🍎" },
                { name: "Roasted chana (30g)", calories: 130, protein: 8, carbs: 20, fat: 3, emoji: "🌰" }
            ]
        },
        muscle_gain: {
            breakfast: [
                { name: "Paneer paratha (2) + curd + lassi", calories: 560, protein: 26, carbs: 62, fat: 20, emoji: "🫓" },
                { name: "Soy protein shake + banana + peanut butter toast", calories: 520, protein: 34, carbs: 58, fat: 14, emoji: "🥤" }
            ],
            lunch: [
                { name: "Rajma chawal + curd + salad", calories: 600, protein: 28, carbs: 85, fat: 10, emoji: "🍛" },
                { name: "Paneer tikka (150g) + brown rice + dal", calories: 620, protein: 36, carbs: 72, fat: 16, emoji: "🧀" }
            ],
            dinner: [
                { name: "Tofu stir-fry + quinoa + roasted veggies", calories: 560, protein: 32, carbs: 55, fat: 16, emoji: "🥦" },
                { name: "Dal makhani + 3 roti + raita", calories: 600, protein: 26, carbs: 78, fat: 16, emoji: "🫘" }
            ],
            snacks: [
                { name: "Soy milk smoothie + banana", calories: 280, protein: 18, carbs: 38, fat: 6, emoji: "🥛" },
                { name: "Mixed nuts + seeds (40g)", calories: 240, protein: 8, carbs: 10, fat: 20, emoji: "🥜" }
            ]
        },
        endurance: {
            breakfast: [
                { name: "Banana oat pancakes + honey + milk", calories: 440, protein: 14, carbs: 78, fat: 8, emoji: "🥞" },
                { name: "Poha with peas & peanuts + coconut water", calories: 400, protein: 12, carbs: 68, fat: 9, emoji: "🥄" }
            ],
            lunch: [
                { name: "Chole + rice + salad + buttermilk", calories: 510, protein: 20, carbs: 82, fat: 9, emoji: "🍱" },
                { name: "Whole wheat pasta + tomato sauce + paneer", calories: 500, protein: 24, carbs: 70, fat: 12, emoji: "🍝" }
            ],
            dinner: [
                { name: "Sweet potato sabzi + dal + 2 roti", calories: 440, protein: 18, carbs: 65, fat: 8, emoji: "🍠" },
                { name: "Dal khichdi + papad + buttermilk", calories: 420, protein: 18, carbs: 65, fat: 8, emoji: "🥘" }
            ],
            snacks: [
                { name: "Dates (5) + walnuts + coconut water", calories: 200, protein: 4, carbs: 36, fat: 7, emoji: "🌴" },
                { name: "Fruit chaat + lemon juice", calories: 160, protein: 3, carbs: 38, fat: 1, emoji: "🍊" }
            ]
        },
        strength: {
            breakfast: [
                { name: "Paneer scramble (150g) + 2 toast + milk", calories: 520, protein: 34, carbs: 40, fat: 22, emoji: "🧀" },
                { name: "Peanut butter banana shake + multigrain toast", calories: 500, protein: 22, carbs: 58, fat: 18, emoji: "🥜" }
            ],
            lunch: [
                { name: "Soybean curry + brown rice + salad", calories: 580, protein: 36, carbs: 68, fat: 14, emoji: "🫘" },
                { name: "Paneer bhurji + 3 roti + dal tadka", calories: 600, protein: 32, carbs: 65, fat: 20, emoji: "🧀" }
            ],
            dinner: [
                { name: "Tofu tikka + dal makhani + 2 roti", calories: 560, protein: 30, carbs: 55, fat: 20, emoji: "🥦" },
                { name: "Palak tofu + quinoa + roasted veggies", calories: 540, protein: 28, carbs: 52, fat: 18, emoji: "🥬" }
            ],
            snacks: [
                { name: "Peanut butter (2 tbsp) + banana + soy milk", calories: 320, protein: 16, carbs: 38, fat: 14, emoji: "💪" },
                { name: "Roasted makhana + mixed seeds", calories: 200, protein: 10, carbs: 28, fat: 6, emoji: "🌰" }
            ]
        },
        maintenance: {
            breakfast: [
                { name: "Idli (4) + sambar + coconut chutney", calories: 350, protein: 14, carbs: 58, fat: 8, emoji: "🫓" },
                { name: "Muesli + milk + seasonal fruits", calories: 370, protein: 14, carbs: 60, fat: 9, emoji: "🥣" }
            ],
            lunch: [
                { name: "Dal + rice + mixed sabzi + curd", calories: 480, protein: 20, carbs: 72, fat: 11, emoji: "🍱" },
                { name: "Whole wheat roti + paneer curry + salad", calories: 460, protein: 24, carbs: 52, fat: 14, emoji: "🫓" }
            ],
            dinner: [
                { name: "Vegetable quinoa pulao + raita + dal", calories: 440, protein: 18, carbs: 58, fat: 10, emoji: "🥘" },
                { name: "Masoor dal + 2 roti + stir-fried veggies", calories: 420, protein: 18, carbs: 55, fat: 9, emoji: "🫘" }
            ],
            snacks: [
                { name: "Sprouts chaat", calories: 160, protein: 10, carbs: 24, fat: 3, emoji: "🌱" },
                { name: "Fruit bowl with yogurt", calories: 180, protein: 8, carbs: 30, fat: 4, emoji: "🍓" }
            ]
        }
    };

    // ---- NON-VEG MEAL PLANS ----
    const nonVegMealPlans = {
        weight_loss: {
            breakfast: [
                { name: "Oats with berries & chia seeds", calories: 320, protein: 12, carbs: 52, fat: 7, emoji: "🥣" },
                { name: "2 boiled eggs + brown bread toast + black coffee", calories: 300, protein: 18, carbs: 34, fat: 10, emoji: "🥚" }
            ],
            lunch: [
                { name: "Grilled chicken salad with lemon dressing", calories: 380, protein: 35, carbs: 18, fat: 12, emoji: "🥗" },
                { name: "Chicken soup + moong dal + 2 roti", calories: 400, protein: 32, carbs: 45, fat: 9, emoji: "🍲" }
            ],
            dinner: [
                { name: "Baked fish + steamed broccoli & carrots", calories: 340, protein: 38, carbs: 18, fat: 10, emoji: "🐟" },
                { name: "Grilled chicken breast + cucumber salad + 1 roti", calories: 360, protein: 40, carbs: 20, fat: 10, emoji: "🍗" }
            ],
            snacks: [
                { name: "Apple + 10 almonds", calories: 150, protein: 4, carbs: 22, fat: 8, emoji: "🍎" },
                { name: "Boiled eggs (2)", calories: 140, protein: 12, carbs: 1, fat: 10, emoji: "🥚" }
            ]
        },
        muscle_gain: {
            breakfast: [
                { name: "6 egg omelette + 2 whole grain toast + milk", calories: 560, protein: 42, carbs: 42, fat: 20, emoji: "🍳" },
                { name: "Chicken keema paratha + lassi + banana", calories: 580, protein: 38, carbs: 60, fat: 18, emoji: "🫓" }
            ],
            lunch: [
                { name: "200g chicken breast + brown rice + broccoli", calories: 620, protein: 52, carbs: 65, fat: 12, emoji: "🍗" },
                { name: "Mutton curry + 3 roti + dal + curd", calories: 680, protein: 48, carbs: 65, fat: 22, emoji: "🍖" }
            ],
            dinner: [
                { name: "Salmon + quinoa + asparagus + olive oil", calories: 580, protein: 48, carbs: 45, fat: 18, emoji: "🐠" },
                { name: "Egg curry + brown rice + salad", calories: 560, protein: 36, carbs: 60, fat: 16, emoji: "🍛" }
            ],
            snacks: [
                { name: "Whey protein shake + banana", calories: 280, protein: 28, carbs: 35, fat: 3, emoji: "🥛" },
                { name: "Tuna sandwich (whole wheat)", calories: 320, protein: 30, carbs: 30, fat: 8, emoji: "🐟" }
            ]
        },
        endurance: {
            breakfast: [
                { name: "Banana oat pancakes + 2 eggs + honey", calories: 480, protein: 20, carbs: 76, fat: 10, emoji: "🥞" },
                { name: "Poha with chicken keema + coconut water", calories: 420, protein: 22, carbs: 62, fat: 9, emoji: "🥄" }
            ],
            lunch: [
                { name: "Chicken pasta + tomato sauce + salad", calories: 540, protein: 36, carbs: 70, fat: 11, emoji: "🍝" },
                { name: "Fish curry + rice + salad + buttermilk", calories: 510, protein: 30, carbs: 68, fat: 12, emoji: "🐟" }
            ],
            dinner: [
                { name: "Sweet potato + grilled chicken + greens", calories: 460, protein: 38, carbs: 50, fat: 9, emoji: "🍠" },
                { name: "Dal + egg bhurji + 2 roti + buttermilk", calories: 440, protein: 28, carbs: 52, fat: 12, emoji: "🥚" }
            ],
            snacks: [
                { name: "Boiled eggs (2) + orange juice", calories: 210, protein: 14, carbs: 22, fat: 8, emoji: "🍊" },
                { name: "Dates + walnuts + energy bar", calories: 230, protein: 6, carbs: 36, fat: 9, emoji: "🌴" }
            ]
        },
        strength: {
            breakfast: [
                { name: "Masala omelette (4 eggs) + milk + toast", calories: 540, protein: 36, carbs: 32, fat: 26, emoji: "🍳" },
                { name: "Peanut butter toast + chicken sausage + shake", calories: 560, protein: 42, carbs: 42, fat: 22, emoji: "🥜" }
            ],
            lunch: [
                { name: "250g lean beef / chicken + roasted potatoes + veg", calories: 660, protein: 55, carbs: 50, fat: 22, emoji: "🥩" },
                { name: "Chicken biryani + raita + salad", calories: 640, protein: 44, carbs: 68, fat: 20, emoji: "🍛" }
            ],
            dinner: [
                { name: "Steak / mutton + mashed potato + spinach", calories: 640, protein: 52, carbs: 42, fat: 26, emoji: "🥩" },
                { name: "Egg bhurji + dal makhani + 3 roti", calories: 580, protein: 36, carbs: 62, fat: 20, emoji: "🧀" }
            ],
            snacks: [
                { name: "Casein shake + peanut butter", calories: 320, protein: 30, carbs: 20, fat: 16, emoji: "💪" },
                { name: "Tuna on crackers + boiled egg", calories: 280, protein: 30, carbs: 18, fat: 8, emoji: "🐟" }
            ]
        },
        maintenance: {
            breakfast: [
                { name: "Idli (4) + sambar + 2 boiled eggs", calories: 400, protein: 22, carbs: 58, fat: 10, emoji: "🫓" },
                { name: "Muesli + milk + seasonal fruits", calories: 370, protein: 14, carbs: 60, fat: 9, emoji: "🥣" }
            ],
            lunch: [
                { name: "Dal + rice + chicken curry + salad", calories: 520, protein: 32, carbs: 65, fat: 14, emoji: "🍱" },
                { name: "Fish curry + brown rice + curd + salad", calories: 500, protein: 36, carbs: 52, fat: 14, emoji: "🐟" }
            ],
            dinner: [
                { name: "Grilled chicken + stir-fried veggies + quinoa", calories: 460, protein: 38, carbs: 45, fat: 12, emoji: "🍗" },
                { name: "Egg curry + 2 roti + mixed veg + salad", calories: 450, protein: 28, carbs: 50, fat: 14, emoji: "🥚" }
            ],
            snacks: [
                { name: "Boiled egg (1) + sprouts chaat", calories: 180, protein: 14, carbs: 20, fat: 5, emoji: "🌱" },
                { name: "Fruit bowl + yogurt", calories: 180, protein: 8, carbs: 30, fat: 4, emoji: "🍓" }
            ]
        }
    };

    const goalKey = goal.includes('weight loss') || goal.includes('lose') ? 'weight_loss'
        : goal.includes('muscle') || goal.includes('gain') ? 'muscle_gain'
        : goal.includes('endurance') ? 'endurance'
        : goal.includes('strength') ? 'strength'
        : 'maintenance';

    const selectedPlan = isVeg ? vegMealPlans[goalKey] : nonVegMealPlans[goalKey];

    // BMI-specific tips (veg-aware)
    const bmiTips = {
        underweight: isVeg ? [
            "Eat every 3 hours — add paneer, nuts, seeds to every meal",
            "Use ghee or coconut oil generously in cooking",
            "Drink high-calorie smoothies: banana + milk + peanut butter",
            "Focus on calorie-dense foods: avocado, rajma, chana",
            "Prioritize strength training to convert calories into muscle"
        ] : [
            "Eat every 3 hours to maintain a caloric surplus",
            "Add healthy fats to meals: ghee, nuts, avocado",
            "Lean meats like chicken and fish aid muscle building",
            "Prioritize strength training to build muscle mass",
            "Drink protein shakes and smoothies between meals"
        ],
        normal: isVeg ? [
            "Keep protein up with paneer, dal, soy, and legumes daily",
            "Rotate your protein sources to cover all amino acids",
            "Include a variety of colorful vegetables each day",
            "Track portions but avoid obsessive restriction",
            "Stay consistent with meal timing for best results"
        ] : [
            "Maintain balanced macro ratios for your goal",
            "Rotate protein: chicken, fish, eggs, legumes",
            "Prioritize whole foods over processed options",
            "Include a variety of colorful vegetables daily",
            "Track portions but avoid obsessive restriction"
        ],
        overweight: isVeg ? [
            "Reduce maida, white rice & fried foods first",
            "Fill half your plate with non-starchy vegetables",
            "Replace paneer with tofu to cut calories",
            "Avoid liquid calories: chai with sugar, packaged juices",
            "Cook at home using minimal oil, prefer steaming/grilling"
        ] : [
            "Reduce refined carbs and fried foods first",
            "Fill half your plate with non-starchy vegetables",
            "Choose lean meats: chicken breast, fish over red meat",
            "Avoid liquid calories: soda, juice, alcohol",
            "Cook at home more often to control ingredients"
        ],
        obese: isVeg ? [
            "Consult a nutritionist for a personalized plan",
            "Start small: cut one processed food per week",
            "Focus on fiber-rich foods: veggies, legumes, whole grains",
            "Avoid ultra-processed snacks, biscuits & fast food",
            "Track your food intake in an app for awareness"
        ] : [
            "Consult a nutritionist for a personalized plan",
            "Start with small, sustainable changes",
            "Focus on high-protein, low-fat meats like chicken and fish",
            "Cut out ultra-processed foods and fast food",
            "Track your food intake in an app for awareness"
        ]
    };

    const waterLiters = (weight * 0.033).toFixed(1);

    res.json({
        success: true,
        bmi,
        bmiCategory,
        goalLabel,
        calorieTarget,
        dietPreference: diet_preference || 'non-veg',
        macros: {
            protein: proteinTarget,
            carbs: carbTarget,
            fat: fatTarget
        },
        meals: selectedPlan,
        tips: bmiTips[bmiCategory],
        waterRecommendation: waterLiters,
        tdee
    });
});

// ================= SERVER =================

server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
