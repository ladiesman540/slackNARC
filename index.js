const express = require('express');
const { MongoClient } = require('mongodb');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
let dbClient;
let db;

async function connectToDatabase() {
  try {
    const uri = process.env.MONGODB_URI;
    dbClient = new MongoClient(uri);
    await dbClient.connect();
    db = dbClient.db('slack-analytics');
    console.log('Connected to MongoDB');
    return db;
  } catch (error) {
    console.error('Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

// Connect to database on startup
connectToDatabase();

// Middleware
app.use(bodyParser.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).send({ status: 'ok', message: 'Slack Insights API is running' });
});

// Slack verification endpoint
app.post('/slack/events', async (req, res) => {
  // Handle Slack URL verification challenge
  if (req.body.type === 'url_verification') {
    return res.json({ challenge: req.body.challenge });
  }
  
  // Process event
  if (req.body.event && req.body.event.type === 'message') {
    try {
      // Skip message updates or bot messages
      if (req.body.event.subtype === 'message_changed' || req.body.event.bot_id) {
        return res.status(200).send();
      }
      
      const collection = db.collection('messages');
      
      const message = {
        team_id: req.body.team_id,
        channel_id: req.body.event.channel,
        user_id: req.body.event.user,
        text: req.body.event.text,
        ts: req.body.event.ts,
        thread_ts: req.body.event.thread_ts,
        processed: false,
        created_at: new Date()
      };
      
      await collection.insertOne(message);
      console.log('Message stored:', message.ts);
    } catch (error) {
      console.error('Error storing message:', error);
    }
  }
  
  // Acknowledge receipt to Slack quickly (required within 3 seconds)
  res.status(200).send();
});

// Insights API endpoint
app.get('/api/insights', async (req, res) => {
  try {
    const collection = db.collection('insights');
    const insights = await collection.find({})
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();
    
    res.status(200).json(insights);
  } catch (error) {
    console.error('Error fetching insights:', error);
    res.status(500).json({ error: 'Failed to fetch insights' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing MongoDB connection');
  await dbClient.close();
  process.exit(0);
});
