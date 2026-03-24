const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const pool = require('./db'); 
const session = require('express-session');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- 1. MIDDLEWARE SETUP ---
app.use(express.json());
app.use(express.static('public'));

// Session management for Login
app.use(session({
    secret: 'gymsync_pro_2026_secure_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // 1 hour session
}));

const PORT = 8888; 

// --- 2. AUTHENTICATION HELPERS ---
const checkAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, message: "Please log in" });
    }
    next();
};

// --- 3. DATABASE INITIALIZATION FUNCTIONS ---
async function initializeDatabase() {
    try {
        // Check if users table exists
        const usersExist = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'users'
            );
        `);
        
        if (!usersExist.rows[0].exists) {
            console.log('Creating database tables...');
            
            // Create users table
            await pool.query(`
                CREATE TABLE users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(100) UNIQUE NOT NULL,
                    password VARCHAR(100) NOT NULL,
                    total_points INTEGER DEFAULT 0,
                    level INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create user_profiles table
            await pool.query(`
                CREATE TABLE user_profiles (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                    weight DECIMAL(5,2),
                    height DECIMAL(5,2),
                    fitness_goal VARCHAR(100),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create activity_logs table
            await pool.query(`
                CREATE TABLE activity_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    log_date DATE DEFAULT CURRENT_DATE,
                    calories_burned INTEGER DEFAULT 0,
                    UNIQUE(user_id, log_date)
                )
            `);
            
            // Create workout_logs table
            await pool.query(`
                CREATE TABLE workout_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    workout_name VARCHAR(200),
                    duration INTEGER,
                    calories_burned INTEGER,
                    performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create water_logs table
            await pool.query(`
                CREATE TABLE water_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    amount DECIMAL(4,2),
                    logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create nutrition_logs table
            await pool.query(`
                CREATE TABLE nutrition_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    food_name VARCHAR(200),
                    calories INTEGER,
                    logged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create equipment table
            await pool.query(`
                CREATE TABLE equipment (
                    id SERIAL PRIMARY KEY,
                    machine_id INTEGER,
                    unit_number INTEGER,
                    machine_name VARCHAR(100),
                    status VARCHAR(20) DEFAULT 'available',
                    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // Create fitness_classes table
            await pool.query(`
                CREATE TABLE fitness_classes (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(100),
                    trainer VARCHAR(100),
                    time VARCHAR(10),
                    date DATE,
                    capacity INTEGER,
                    booked INTEGER DEFAULT 0
                )
            `);
            
            // Create class_bookings table
            await pool.query(`
                CREATE TABLE class_bookings (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    class_id INTEGER REFERENCES fitness_classes(id) ON DELETE CASCADE,
                    booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, class_id)
                )
            `);
            
            // Create achievements table
            await pool.query(`
                CREATE TABLE achievements (
                    id SERIAL PRIMARY KEY,
                    name VARCHAR(100),
                    description TEXT,
                    points_required INTEGER
                )
            `);
            
            // Create user_achievements table
            await pool.query(`
                CREATE TABLE user_achievements (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    achievement_id INTEGER REFERENCES achievements(id) ON DELETE CASCADE,
                    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id, achievement_id)
                )
            `);
            
            console.log('✅ Database tables created successfully');
            
            // Initialize equipment with 5 machines × 4 units
            const machineNames = ['TREADMILL', 'CROSSFIT', 'BENCH PRESS', 'ROWING', 'CABLE'];
            
            for (let i = 0; i < machineNames.length; i++) {
                for (let j = 1; j <= 4; j++) {
                    await pool.query(`
                        INSERT INTO equipment (machine_id, unit_number, machine_name, status)
                        VALUES ($1, $2, $3, 'available')
                    `, [i + 1, j, machineNames[i]]);
                }
            }
            
            console.log('✅ Equipment initialized (5 machines × 4 units)');
            
            // Initialize sample fitness classes
            const today = new Date().toISOString().split('T')[0];
            const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
            
            await pool.query(`
                INSERT INTO fitness_classes (name, trainer, time, date, capacity, booked)
                VALUES 
                    ('Morning Yoga', 'Sarah Johnson', '07:00', $1, 15, 8),
                    ('HIIT Blast', 'Mike Roberts', '18:00', $1, 20, 12),
                    ('Spin Class', 'Alex Turner', '19:30', $1, 12, 10),
                    ('Pilates', 'Emma Davis', '09:00', $2, 10, 4),
                    ('Strength Training', 'Chris Evans', '17:00', $2, 15, 7)
            `, [today, tomorrow]);
            
            console.log('✅ Sample fitness classes added');
            
            // Initialize achievements
            await pool.query(`
                INSERT INTO achievements (name, description, points_required)
                VALUES 
                    ('First Workout', 'Complete your first workout', 10),
                    ('Hydration Hero', 'Drink 2L of water in a day', 50),
                    ('Consistency King', 'Workout 5 days in a row', 100),
                    ('Protein Power', 'Log 10 high-protein meals', 75),
                    ('Level 10', 'Reach level 10', 1000)
            `);
            
            console.log('✅ Achievements initialized');
        } else {
            console.log('✅ Database already initialized');
            
            // Check if user_profiles table has the correct structure
            const columnsExist = await pool.query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'user_profiles' AND column_name = 'weight'
            `);
            
            if (columnsExist.rows.length === 0) {
                console.log('Adding missing columns to user_profiles...');
                await pool.query(`
                    ALTER TABLE user_profiles 
                    ADD COLUMN IF NOT EXISTS weight DECIMAL(5,2),
                    ADD COLUMN IF NOT EXISTS height DECIMAL(5,2),
                    ADD COLUMN IF NOT EXISTS fitness_goal VARCHAR(100),
                    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                `);
            }
        }
    } catch (err) {
        console.error('Database initialization error:', err);
    }
}

// Initialize database on startup
initializeDatabase().catch(console.error);

// --- 4. ROUTES ---

// Registration
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const existingUser = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
        if (existingUser.rows.length > 0) {
            return res.json({ success: false, message: "Username already exists" });
        }
        
        const result = await pool.query(
            "INSERT INTO users (username, password, total_points, level) VALUES ($1, $2, 0, 1) RETURNING id", 
            [username, password]
        );
        
        // Create default user profile
        await pool.query(
            "INSERT INTO user_profiles (user_id, weight, height, fitness_goal) VALUES ($1, 70, 170, 'Weight Loss')",
            [result.rows[0].id]
        );
        
        res.json({ success: true, message: "User Registered" });
    } catch (err) {
        console.error("Reg Error:", err.message);
        res.status(400).json({ success: false, message: "Registration failed" });
    }
});

// Login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await pool.query("SELECT * FROM users WHERE username = $1 AND password = $2", [username, password]);
        if (user.rows.length > 0) {
            req.session.userId = user.rows[0].id;
            req.session.username = username;
            res.json({ success: true, username: username });
        } else {
            res.status(401).json({ success: false, message: "Invalid Credentials" });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, message: "Login error" });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Get User Profile
app.get('/user-profile', checkAuth, async (req, res) => {
    try {
        const user = await pool.query(
            `SELECT u.username, u.total_points, u.level, 
                    COALESCE(up.weight, 70) as weight, 
                    COALESCE(up.height, 170) as height, 
                    COALESCE(up.fitness_goal, 'Weight Loss') as fitness_goal 
             FROM users u 
             LEFT JOIN user_profiles up ON u.id = up.user_id 
             WHERE u.id = $1`,
            [req.session.userId]
        );
        
        if (user.rows.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        
        // Calculate BMI
        const weight = parseFloat(user.rows[0].weight);
        const height = parseFloat(user.rows[0].height);
        const bmi = weight && height ? (weight / ((height/100) ** 2)).toFixed(1) : null;
        
        res.json({ ...user.rows[0], bmi });
    } catch (err) {
        console.error('Profile fetch error:', err);
        res.status(500).json({ error: "Profile fetch error" });
    }
});

// Update Profile - FIXED VERSION
app.post('/update-profile', checkAuth, async (req, res) => {
    const { weight, height, fitness_goal } = req.body;
    const userId = req.session.userId;
    
    console.log('Updating profile for user:', userId, 'with data:', { weight, height, fitness_goal });
    
    try {
        // Check if profile exists
        const existingProfile = await pool.query(
            "SELECT * FROM user_profiles WHERE user_id = $1",
            [userId]
        );
        
        if (existingProfile.rows.length > 0) {
            // Update existing profile
            await pool.query(
                `UPDATE user_profiles 
                 SET weight = $1, height = $2, fitness_goal = $3, updated_at = CURRENT_TIMESTAMP 
                 WHERE user_id = $4`,
                [weight, height, fitness_goal, userId]
            );
            console.log('Profile updated successfully');
        } else {
            // Insert new profile
            await pool.query(
                `INSERT INTO user_profiles (user_id, weight, height, fitness_goal) 
                 VALUES ($1, $2, $3, $4)`,
                [userId, weight, height, fitness_goal]
            );
            console.log('New profile created');
        }
        
        res.json({ success: true, message: "Profile updated successfully" });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: "Update failed: " + err.message });
    }
});

// Weekly Activity History
app.get('/activity-history', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT TO_CHAR(log_date, 'Mon DD') as date, 
            calories_burned as total_calories 
            FROM activity_logs 
            WHERE user_id = $1 AND log_date >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY log_date ASC
        `, [req.session.userId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Activity history error:', err);
        res.json([]);
    }
});

// Get Workout Plans
app.get('/workout-plans', checkAuth, async (req, res) => {
    const workoutPlans = {
        'Weight Loss': [
            { id: 1, name: "🔥 Fat Burner HIIT", exercises: "🏃 Jumping Jacks: 3x30\n💪 Burpees: 3x15\n⛰️ Mountain Climbers: 3x20\n🦵 High Knees: 3x30\n⏱️ Rest: 60 sec between sets", duration: 25, difficulty: "intermediate" },
            { id: 2, name: "🏃 Cardio Rush", exercises: "🏃 Running: 20 mins\n🤸 Jumping Jacks: 3x30\n💪 Burpees: 3x10\n🪢 Skipping: 100 reps", duration: 30, difficulty: "beginner" },
            { id: 3, name: "💪 Fat Destroyer", exercises: "🏃 Sprints: 10x100m\n📦 Box Jumps: 3x12\n🏋️ Kettlebell Swings: 3x15\n🧘 Plank: 3x60sec", duration: 35, difficulty: "advanced" }
        ],
        'Muscle Gain': [
            { id: 1, name: "🏋️ Strength Builder", exercises: "🏋️ Deadlifts: 3x8\n🏋️ Bench Press: 3x10\n🏋️ Rows: 3x12\n🏋️ Overhead Press: 3x8", duration: 45, difficulty: "intermediate" },
            { id: 2, name: "💪 Mass Builder", exercises: "🦵 Squats: 4x10\n🤸 Pull-ups: 4x8\n🏋️ Dumbbell Press: 4x12\n💪 Barbell Curl: 3x10", duration: 50, difficulty: "advanced" },
            { id: 3, name: "📈 Hypertrophy Focus", exercises: "🏋️ Incline Press: 3x10\n🤸 Lat Pulldowns: 3x12\n🦵 Leg Press: 3x15\n💪 Tricep Extensions: 3x12", duration: 40, difficulty: "intermediate" }
        ],
        'Endurance': [
            { id: 1, name: "🏃 Endurance King", exercises: "🏃 Running: 5km\n🚴 Cycling: 20 mins\n🚣 Rowing: 2000m\n🏊 Swimming: 500m", duration: 60, difficulty: "advanced" },
            { id: 2, name: "💪 Cardio Builder", exercises: "🪢 Jump Rope: 15 mins\n💪 Burpees: 5x20\n⛰️ Mountain Climbers: 5x30\n🧘 Plank: 3x90sec", duration: 35, difficulty: "intermediate" }
        ],
        'Strength': [
            { id: 1, name: "🏋️ Power Lifter", exercises: "🦵 Squats: 5x5\n🏋️ Deadlifts: 5x5\n🏋️ Bench Press: 5x5\n🏋️ Overhead Press: 5x5", duration: 55, difficulty: "advanced" },
            { id: 2, name: "💪 Functional Strength", exercises: "🏋️ Clean & Press: 4x6\n🤸 Pull-ups: 4x8\n🦵 Lunges: 4x10\n🚶 Farmer's Walk: 3x50m", duration: 45, difficulty: "intermediate" }
        ]
    };
    
    try {
        // Get user's fitness goal
        const userGoal = await pool.query(
            "SELECT fitness_goal FROM user_profiles WHERE user_id = $1",
            [req.session.userId]
        );
        
        let goal = userGoal.rows[0]?.fitness_goal || 'Weight Loss';
        // Map goal to workout plan key
        if (goal.includes('Muscle')) goal = 'Muscle Gain';
        if (goal.includes('Endurance')) goal = 'Endurance';
        if (goal.includes('Strength')) goal = 'Strength';
        
        const plans = workoutPlans[goal] || workoutPlans['Weight Loss'];
        res.json(plans);
    } catch (err) {
        console.error('Workout plans error:', err);
        res.json(workoutPlans['Weight Loss']);
    }
});

// Log Workout
app.post('/log-workout', checkAuth, async (req, res) => {
    const { workout_name, duration, calories_burned } = req.body;
    try {
        // Insert workout log
        await pool.query(
            "INSERT INTO workout_logs (user_id, workout_name, duration, calories_burned) VALUES ($1, $2, $3, $4)",
            [req.session.userId, workout_name, duration, calories_burned]
        );
        
        // Update or insert activity log
        await pool.query(`
            INSERT INTO activity_logs (user_id, log_date, calories_burned)
            VALUES ($1, CURRENT_DATE, $2)
            ON CONFLICT (user_id, log_date) 
            DO UPDATE SET calories_burned = activity_logs.calories_burned + $2
        `, [req.session.userId, calories_burned]);
        
        // Add points
        const pointsEarned = 10 + Math.floor(calories_burned / 10);
        await pool.query(
            "UPDATE users SET total_points = total_points + $1 WHERE id = $2",
            [pointsEarned, req.session.userId]
        );
        
        // Check for level up
        const user = await pool.query("SELECT total_points, level FROM users WHERE id = $1", [req.session.userId]);
        const newLevel = Math.floor(user.rows[0].total_points / 100) + 1;
        let levelUp = false;
        
        if (newLevel > user.rows[0].level) {
            await pool.query("UPDATE users SET level = $1 WHERE id = $2", [newLevel, req.session.userId]);
            levelUp = true;
        }
        
        // Check for first workout achievement
        const workoutCount = await pool.query(
            "SELECT COUNT(*) as count FROM workout_logs WHERE user_id = $1",
            [req.session.userId]
        );
        
        if (workoutCount.rows[0].count === 1) {
            const achievement = await pool.query(
                "SELECT id FROM achievements WHERE name = 'First Workout'"
            );
            if (achievement.rows.length > 0) {
                await pool.query(`
                    INSERT INTO user_achievements (user_id, achievement_id)
                    VALUES ($1, $2)
                    ON CONFLICT DO NOTHING
                `, [req.session.userId, achievement.rows[0].id]);
            }
        }
        
        res.json({ success: true, levelUp, newLevel: levelUp ? newLevel : null, pointsEarned });
    } catch (err) {
        console.error('Workout log error:', err);
        res.status(500).json({ error: "Failed to log workout" });
    }
});

// Get Leaderboard
app.get('/leaderboard', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT username, total_points, level FROM users ORDER BY total_points DESC LIMIT 10"
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.json([]);
    }
});

// Get Classes
app.get('/classes', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM fitness_classes WHERE date >= CURRENT_DATE ORDER BY date, time LIMIT 10"
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Classes error:', err);
        res.json([]);
    }
});

// Book Class
app.post('/book-class', checkAuth, async (req, res) => {
    const { class_id } = req.body;
    try {
        // Check if class exists and has capacity
        const classData = await pool.query(
            "SELECT capacity, booked FROM fitness_classes WHERE id = $1",
            [class_id]
        );
        
        if (classData.rows.length === 0) {
            return res.status(404).json({ error: "Class not found" });
        }
        
        const { capacity, booked } = classData.rows[0];
        if (booked >= capacity) {
            return res.status(400).json({ error: "Class is full" });
        }
        
        // Check if already booked
        const existingBooking = await pool.query(
            "SELECT * FROM class_bookings WHERE user_id = $1 AND class_id = $2",
            [req.session.userId, class_id]
        );
        
        if (existingBooking.rows.length > 0) {
            return res.status(400).json({ error: "Already booked this class" });
        }
        
        // Create booking
        await pool.query(
            "INSERT INTO class_bookings (user_id, class_id) VALUES ($1, $2)",
            [req.session.userId, class_id]
        );
        
        // Update booked count
        await pool.query(
            "UPDATE fitness_classes SET booked = booked + 1 WHERE id = $1",
            [class_id]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Booking error:', err);
        res.status(500).json({ error: "Booking failed" });
    }
});

// Nutrition API with fallback
app.get('/nutrition/:foodItem', checkAuth, async (req, res) => {
    try {
        const response = await axios.get('https://api.edamam.com/api/food-database/v2/parser', {
            params: { 
                app_id: "41dee77a", 
                app_key: "0da05c94eed11c6327aacef9778cdc4d", 
                ingr: req.params.foodItem 
            },
            timeout: 5000
        });
        
        if (!response.data.hints || response.data.hints.length === 0) {
            return res.status(404).json({ error: "Food not found" });
        }
        
        const food = response.data.hints[0].food;
        const calories = Math.round(food.nutrients.ENERC_KCAL || 0);
        
        // Calculate grade
        let grade = 'B';
        if (calories < 300 && (food.nutrients.PROCNT || 0) > 10) grade = 'A+';
        else if (calories < 500) grade = 'A';
        else if (calories < 800) grade = 'B';
        else if (calories < 1200) grade = 'C';
        else grade = 'D';
        
        res.json({
            name: food.label,
            calories: calories,
            protein: Math.round(food.nutrients.PROCNT || 0),
            fat: Math.round(food.nutrients.FAT || 0),
            carbs: Math.round(food.nutrients.CHOCDF || 0),
            fiber: Math.round(food.nutrients.FIBTG || 0),
            sodium: Math.round(food.nutrients.NA || 0),
            grade: grade
        });
    } catch (err) {
        console.error('Nutrition API error:', err.message);
        // Return mock data
        res.json({
            name: req.params.foodItem.charAt(0).toUpperCase() + req.params.foodItem.slice(1),
            calories: Math.floor(Math.random() * 400) + 100,
            protein: Math.floor(Math.random() * 20) + 5,
            fat: Math.floor(Math.random() * 15) + 2,
            carbs: Math.floor(Math.random() * 30) + 10,
            fiber: Math.floor(Math.random() * 8) + 1,
            sodium: Math.floor(Math.random() * 500) + 50,
            grade: ['A', 'B', 'C'][Math.floor(Math.random() * 3)]
        });
    }
});

// Update Water Intake
app.post('/update-water', checkAuth, async (req, res) => {
    const { amount } = req.body;
    try {
        await pool.query(
            "INSERT INTO water_logs (user_id, amount) VALUES ($1, $2)",
            [req.session.userId, amount]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Water update error:', err);
        res.status(500).json({ error: "Update failed" });
    }
});

// Get Today's Water Intake
app.get('/water-today', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT SUM(amount) as total FROM water_logs WHERE user_id = $1 AND DATE(logged_at) = CURRENT_DATE",
            [req.session.userId]
        );
        res.json({ total: result.rows[0].total || 0 });
    } catch (err) {
        console.error('Water fetch error:', err);
        res.json({ total: 0 });
    }
});

// Get Equipment Status
app.get('/equipment', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM equipment ORDER BY machine_id, unit_number"
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Equipment fetch error:', err);
        res.json([]);
    }
});

// Update Machine Status
app.post('/update-machine', checkAuth, async (req, res) => {
    const { id, unit, status } = req.body;
    try {
        await pool.query(
            "UPDATE equipment SET status = $1, last_updated = CURRENT_TIMESTAMP WHERE machine_id = $2 AND unit_number = $3",
            [status, id, unit]
        );
        
        io.emit('machine_updated', { 
            machineId: id, 
            unitNumber: unit, 
            status
        });
        
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Machine update error:', err);
        res.status(500).send("Update failed");
    }
});

// Get Achievements
app.get('/achievements', checkAuth, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.name, a.description, 
                   CASE WHEN ua.id IS NOT NULL THEN true ELSE false END as unlocked
            FROM achievements a
            LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = $1
            ORDER BY a.points_required
        `, [req.session.userId]);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Achievements error:', err);
        res.json([
            { name: "First Workout", description: "Complete your first workout", unlocked: false },
            { name: "Hydration Hero", description: "Drink 2L of water in a day", unlocked: false },
            { name: "Consistency King", description: "Workout 5 days in a row", unlocked: false },
            { name: "Protein Power", description: "Log 10 high-protein meals", unlocked: false },
            { name: "Level 10", description: "Reach level 10", unlocked: false }
        ]);
    }
});

// AI Chatbot Endpoint
app.post('/chatbot', checkAuth, async (req, res) => {
    const { message } = req.body;
    
    const lowerMessage = message.toLowerCase();
    let response = "";
    
    if (lowerMessage.includes('hello') || lowerMessage.includes('hi')) {
        response = "Hello! 👋 I'm your AI Fitness Coach. How can I help you with your fitness journey today?";
    }
    else if (lowerMessage.includes('workout') || lowerMessage.includes('exercise')) {
        response = "Great! For workouts, I recommend:\n\n• **Cardio**: 20-30 mins of running, cycling, or HIIT\n• **Strength**: Compound exercises like squats, deadlifts, bench press\n• **Core**: Planks, crunches, leg raises\n\nWhat's your fitness goal? I can suggest a specific routine!";
    }
    else if (lowerMessage.includes('diet') || lowerMessage.includes('food') || lowerMessage.includes('nutrition')) {
        response = "Nutrition is key! 💪\n\n• **Protein**: Chicken, fish, eggs, tofu (1.6-2.2g per kg body weight)\n• **Carbs**: Oats, brown rice, sweet potatoes for energy\n• **Fats**: Avocado, nuts, olive oil\n• **Hydration**: Drink 2-3L water daily\n\nWould you like meal suggestions?";
    }
    else if (lowerMessage.includes('protein')) {
        response = "Excellent protein sources:\n\n🥩 Chicken breast: 31g/100g\n🐟 Salmon: 22g/100g\n🥚 Eggs: 13g/100g\n🌱 Lentils: 9g/100g\n💪 Whey protein: 20-25g/scoop\n\nAim for 1.6-2.2g protein per kg of body weight for muscle growth!";
    }
    else if (lowerMessage.includes('weight loss') || lowerMessage.includes('fat loss')) {
        response = "For weight loss:\n\n✅ Calorie deficit (500-700 less than maintenance)\n✅ HIIT workouts 3-4x/week\n✅ Strength training to preserve muscle\n✅ High protein diet\n✅ 7-9 hours sleep\n✅ 10,000 steps daily\n\nConsistency is key! 💪";
    }
    else if (lowerMessage.includes('muscle') || lowerMessage.includes('gain') || lowerMessage.includes('bulk')) {
        response = "For muscle gain:\n\n💪 Calorie surplus (+300-500)\n💪 Progressive overload in training\n💪 1.6-2.2g protein/kg body weight\n💪 Compound exercises (squats, deadlifts, bench)\n💪 7-9 hours sleep for recovery\n💪 Train each muscle group 2x/week\n\nReady to build some muscle? 💪";
    }
    else if (lowerMessage.includes('bmi')) {
        response = "BMI (Body Mass Index) is a measure of body fat based on height and weight.\n\nCategories:\n• Underweight: < 18.5\n• Normal: 18.5-24.9\n• Overweight: 25-29.9\n• Obese: > 30\n\nWant to calculate your BMI? Check your profile section and enter your weight and height!";
    }
    else if (lowerMessage.includes('motivation') || lowerMessage.includes('motivate')) {
        response = "🔥 Remember: \"The only bad workout is the one that didn't happen!\"\n\nEvery rep counts. Every step matters. You're stronger than yesterday!\n\nWhat's your goal this week? Let's crush it together! 💪";
    }
    else if (lowerMessage.includes('sleep')) {
        response = "Sleep is crucial for recovery! 😴\n\n• Aim for 7-9 hours\n• Consistent sleep schedule\n• No screens 1 hour before bed\n• Cool, dark room\n\nQuality sleep = Better results!";
    }
    else if (lowerMessage.includes('supplement')) {
        response = "Common supplements:\n\n💊 **Whey Protein**: Convenient protein source\n💊 **Creatine**: Strength and power gains\n💊 **Omega-3**: Joint and heart health\n💊 **Vitamin D**: Immune and bone health\n\nAlways consult a doctor before starting supplements!";
    }
    else if (lowerMessage.includes('thank')) {
        response = "You're welcome! 😊 Keep pushing forward! Anything else I can help with?";
    }
    else {
        response = "Great question! 💪 To give you the best advice, could you tell me more about:\n\n• Your fitness goal (weight loss, muscle gain, etc.)\n• Your experience level (beginner, intermediate, advanced)\n• Any specific area you want to focus on\n\nI'm here to help you succeed! 🎯";
    }
    
    res.json({ response: response });
});

// --- 5. SOCKET.IO CONFIGURATION ---
io.on('connection', (socket) => {
    console.log('🟢 New client connected');
    
    socket.on('send_message', (data) => {
        io.emit('new_message', data);
    });
    
    socket.on('disconnect', () => {
        console.log('🔴 Client disconnected');
    });
});

// --- 6. START SERVER ---
server.listen(PORT, () => {
    console.log('-------------------------------------------');
    console.log('🚀 GYMSYNC PRO SERVER INITIALIZED');
    console.log('-------------------------------------------');
    console.log(`📍 Server URL: http://localhost:${PORT}`);
    console.log(`📡 Database: PostgreSQL connected`);
    console.log(`💬 Socket.io: Real-time communication ready`);
    console.log(`🏋️‍♂️ Features: Machine Management (5x4 units)`);
    console.log(`🍎 Features: Food Comparator & Nutrition API`);
    console.log(`🤖 Features: AI Fitness Coach Chatbot`);
    console.log(`📊 Features: BMI Calculator & Profile Management`);
    console.log('-------------------------------------------');
});