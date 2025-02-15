import { MongoClient } from 'mongodb';

let cachedDb: MongoClient;

export async function connectToDB(): Promise<MongoClient> {
  if (cachedDb && cachedDb.isConnected()) {
    return Promise.resolve(cachedDb);
  }

  const client = await MongoClient.connect(process.env.DB_URL as string, {
    useNewUrlParser: true,
  });

  cachedDb = client;

  return client;
}

export default connectToDB;
