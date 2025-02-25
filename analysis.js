const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');
const https = require('https');

// Load environment variables
dotenv.config();

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

async function getUnprocessedMessages(hoursLookback = 24) {
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - hoursLookback);
  
  const collection = db.collection('messages');
  return collection.find({
    processed: false,
    created_at: { $gte: cutoffTime }
  }).toArray();
}

async function groupMessagesByChannel(messages) {
  const channels = {};
  
  for (const msg of messages) {
    const channelId = msg.channel_id;
    if (!channels[channelId]) {
      channels[channelId] = [];
    }
    channels[channelId].push(msg);
  }
  
  return channels;
}

function callOpenAI(messageText) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    
    const requestData = JSON.stringify({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: `You're analyzing Slack conversations to identify:
          1. Key issues or problems mentioned
          2. Action items that need attention
          3. Emerging risks to the business
          4. Positive developments
          5. Sentiment summary
          Respond with a structured JSON with these categories.`
        },
        {
          role: "user",
          content: `Analyze these Slack messages from a business channel:\n\n${messageText}`
        }
      ],
      response_format: { type: "json_object" }
    });
    
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.choices && response.choices[0] && response.choices[0].message) {
            resolve(response.choices[0].message.content);
          } else {
            reject(new Error('Invalid response format from OpenAI'));
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.write(requestData);
    req.end();
  });
}

async function analyzeChannelMessages(channelId, messages) {
  if (!messages || messages.length === 0) {
    return null;
  }
  
  // Format messages for analysis
  const formattedMessages = messages.map(msg => `User ${msg.user_id}: ${msg.text}`);
  const messageText = formattedMessages.join('\n');
  
  try {
    // Generate analysis with AI
    const analysis = await callOpenAI(messageText);
    
    // Store insights
    const insightsCollection = db.collection('insights');
    const insight = {
      channel_id: channelId,
      analysis: JSON.parse(analysis), // Parse the JSON string to an object
      message_count: messages.length,
      created_at: new Date()
    };
    
    await insightsCollection.insertOne(insight);
    
    // Mark messages as processed
    const messageIds = messages.map(msg => msg._id);
    const messagesCollection = db.collection('messages');
    await messagesCollection.updateMany(
      { _id: { $in: messageIds } },
      { $set: { processed: true } }
    );
    
    return analysis;
  } catch (error) {
    console.error(`Error analyzing messages for channel ${channelId}:`, error);
    return null;
  }
}

async function runAnalysis() {
  console.log(`Starting analysis at ${new Date()}`);
  
  await connectToDatabase();
  
  const messages = await getUnprocessedMessages();
  console.log(`Found ${messages.length} unprocessed messages`);
  
  const channels = await groupMessagesByChannel(messages);
  
  for (const [channelId, channelMessages] of Object.entries(channels)) {
    console.log(`Analyzing ${channelMessages.length} messages from channel ${channelId}`);
    const analysis = await analyzeChannelMessages(channelId, channelMessages);
    
    if (analysis) {
      console.log(`Analysis complete for channel ${channelId}`);
    }
  }
  
  console.log(`Analysis completed at ${new Date()}`);
  
  // Close the database connection
  await dbClient.close();
}

// Run the analysis if this file is executed directly
if (require.main === module) {
  runAnalysis()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Error running analysis:', error);
      process.exit(1);
    });
}

module.exports = { runAnalysis };
