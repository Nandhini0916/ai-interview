import mongoose from 'mongoose';

const connectDatabase = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI ||'mongodb://127.0.0.1:27017/ai_interview', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    
    // Initialize collections if they don't exist
    await mongoose.connection.db.collection('detections').createIndex({ sessionId: 1, timestamp: 1 });
    await mongoose.connection.db.collection('sessions').createIndex({ sessionId: 1 });
    await mongoose.connection.db.collection('chatmessages').createIndex({ roomId: 1, timestamp: 1 });
    await mongoose.connection.db.collection('reports').createIndex({ sessionId: 1 });
    await mongoose.connection.db.collection('sharedreports').createIndex({ sessionId: 1, recipient: 1 });
    
  } catch (error) {
    console.error('❌ Database connection error:', error);
    process.exit(1);
  }
};

export default connectDatabase;