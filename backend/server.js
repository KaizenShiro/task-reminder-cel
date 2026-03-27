require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database
const db = new sqlite3.Database(path.join(__dirname, 'tasks.db'));
db.run(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    time TEXT NOT NULL,
    reminder INTEGER NOT NULL,
    recurring BOOLEAN DEFAULT 0,
    completed BOOLEAN DEFAULT 0,
    notified BOOLEAN DEFAULT 0,
    lateNotified BOOLEAN DEFAULT 0,
    created TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Telegram config
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: message })
  }).catch(err => console.error('Telegram error:', err));
}

// Routes
app.get('/api/tasks', (req, res) => {
  db.all('SELECT * FROM tasks ORDER BY time ASC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/tasks', (req, res) => {
  const { task, time, reminder, recurring } = req.body;
  if (!task || !time) return res.status(400).json({ error: 'Task and time required' });
  const stmt = db.prepare(`
    INSERT INTO tasks (task, time, reminder, recurring)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(task, time, reminder, recurring ? 1 : 0, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID });
  });
  stmt.finalize();
});

app.put('/api/tasks/:id', (req, res) => {
  const { task, time, reminder, recurring, completed } = req.body;
  const { id } = req.params;
  const stmt = db.prepare(`
    UPDATE tasks SET task=?, time=?, reminder=?, recurring=?, completed=?
    WHERE id=?
  `);
  stmt.run(task, time, reminder, recurring ? 1 : 0, completed ? 1 : 0, id, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
  stmt.finalize();
});

app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM tasks WHERE id=?', id, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// Scheduler: check reminders every minute
cron.schedule('* * * * *', () => {
  const now = new Date();
  db.all('SELECT * FROM tasks WHERE completed = 0', (err, tasks) => {
    if (err) return;
    tasks.forEach(task => {
      const deadline = new Date(task.time);
      const diffMin = (deadline - now) / 60000;
      const reminderMin = task.reminder * 60;

      if (diffMin <= reminderMin && diffMin > 0 && !task.notified) {
        sendTelegram(`🔔 Reminder: ${task.task} dalam ${task.reminder} jam lagi.`);
        db.run('UPDATE tasks SET notified = 1 WHERE id = ?', task.id);
      }
      if (diffMin < 0 && !task.lateNotified) {
        sendTelegram(`❌ Terlambat: ${task.task}`);
        db.run('UPDATE tasks SET lateNotified = 1 WHERE id = ?', task.id);
      }
    });
  });
});

// Scheduler: recurring tasks every day at 00:00
cron.schedule('0 0 * * *', () => {
  db.all('SELECT * FROM tasks WHERE recurring = 1 AND completed = 0', (err, tasks) => {
    if (err) return;
    tasks.forEach(task => {
      const deadline = new Date(task.time);
      if (deadline < new Date()) {
        const nextDay = new Date(deadline);
        nextDay.setDate(deadline.getDate() + 1);
        db.run(`
          INSERT INTO tasks (task, time, reminder, recurring)
          VALUES (?, ?, ?, ?)
        `, task.task, nextDay.toISOString(), task.reminder, 1);
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});