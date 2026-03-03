const mysql = require('mysql2/promise');
const config = require('../config/config.js');

const pool = mysql.createPool(config.dbConfig);

// Мониторинг состояния пула
pool.on('connection', (connection) => {
    console.log(`Новое соединение с БД (id: ${connection.threadId})`);
});

pool.on('acquire', (connection) => {
    console.log(`Соединение получено (id: ${connection.threadId})`);
});

pool.on('release', (connection) => {
    console.log(`Соединение возвращено в пул (id: ${connection.threadId})`);
});

pool.on('error', (err) => {
    console.error('Ошибка пула соединений:', err);
});

// Проверка подключения при старте
async function testConnection() {
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('SELECT 1');
        console.log('Проверка подключения к БД: успешно');
    } catch (err) {
        console.error('❌ Ошибка подключения к БД:', err);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

testConnection();

module.exports = pool;