import express from 'express';
import serverless from 'serverless-http';

const app = express();
app.get('/properties', (_req, res) => res.json([]));
export const handler = serverless(app);
