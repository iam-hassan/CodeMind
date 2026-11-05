import express from 'express';

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(3001, () => console.log('TaskFlow API on :3001'));
