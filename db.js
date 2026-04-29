const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: 'rohan00', // Your actual password
    host: '127.0.0.1',
    database: 'gymsync_db',
    port: 5000, // Your confirmed port
});

pool.connect((err) => {
    if (err) console.error('❌ Connection Error:', err.stack);
    else console.log('✅ Database Connected on Port 5000');
}); 

module.exports = pool;   
