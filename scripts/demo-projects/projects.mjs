/*---------------------------------------------------------------------------------------------
 *  Real demo projects for the test_scenarios.docx Group H walkthrough.
 *
 *  Each entry becomes a real directory on disk (scaffold.mjs) AND a scripted ingestion run
 *  (run.mjs) that drives the real Part 1 pipeline (real provider, real PostgreSQL, real Neo4j).
 *--------------------------------------------------------------------------------------------*/

export const PROJECTS = [
	{
		id: 'taskflow',
		name: 'TaskFlow',
		summary: 'Project management SaaS - project #1 of the doc (S-166/167/168/169/170).',
		setup: 'This is a Next.js 14 app with TypeScript. Backend is Node.js with Express. PostgreSQL database. We are deploying to AWS. Team: 3 people.',
		extraTurns: [
			'Yes, use Prisma over TypeORM because of better TypeScript support.'
		],
		decisions: [
			{ decision: 'Use Prisma as the ORM', reason: 'Better TypeScript support than TypeORM', alternatives: 'TypeORM', rejectedAlternatives: ['TypeORM'], decidedOn: 'Prisma', author: 'developer', decidedAt: '2026-01-08T00:00:00.000Z' }
		],
		events: [
			{ eventType: 'added', description: 'Prisma added as the ORM', occurredAt: '2026-01-08T00:00:00.000Z' }
		],
		// S-168: later the database is deliberately migrated (conflict + versioning).
		migration: { incomingCategory: 'technology_stack', incomingContent: 'We are switching from PostgreSQL to MySQL for persistence because the client requires it', eventDescription: 'Migrated database from PostgreSQL to MySQL', occurredAt: '2026-01-28T00:00:00.000Z' },
		files: {
			'package.json': JSON.stringify({ name: 'taskflow', version: '0.1.0', private: true, scripts: { dev: 'next dev', start: 'node dist/server.js' }, dependencies: { next: '14.2.0', react: '18.3.0', 'react-dom': '18.3.0', express: '4.19.2', '@prisma/client': '5.22.0', typescript: '5.6.3' }, devDependencies: { prisma: '5.22.0', '@types/express': '4.17.21', '@types/node': '22.9.0' } }, null, 2) + '\n',
			'README.md': '# TaskFlow\n\nProject management SaaS.\n\n- Next.js 14 (App Router) + TypeScript frontend\n- Express backend (Node.js)\n- PostgreSQL database\n- ORM: Prisma (chosen over TypeORM for better TypeScript support)\n- Deployed on AWS\n- Team: 3 developers\n',
			'src/server.ts': "import express from 'express';\n\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(3001, () => console.log('TaskFlow API on :3001'));\n",
			'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\ngenerator client {\n  provider = "prisma-client-js"\n}\n\nmodel Task {\n  id    String @id @default(cuid())\n  title String\n}\n',
			'docs/DECISIONS.md': '# Decisions\n\n## ORM\nUse Prisma as the ORM, because it has better TypeScript support than TypeORM. TypeORM was considered and rejected.\n'
		}
	},
	{
		id: 'blogplatform',
		name: 'BlogPlatform',
		summary: 'Solo-developer blog - project #2 (S-171).',
		setup: 'BlogPlatform: Next.js 14, MDX for content, Prisma, PostgreSQL, Vercel deployment, Tailwind, solo developer.',
		extraTurns: [],
		decisions: [],
		events: [],
		files: {
			'package.json': JSON.stringify({ name: 'blogplatform', version: '0.1.0', private: true, dependencies: { next: '14.2.0', react: '18.3.0', 'react-dom': '18.3.0', '@next/mdx': '14.2.0', 'tailwindcss': '3.4.14', '@prisma/client': '5.22.0' }, devDependencies: { prisma: '5.22.0', typescript: '5.6.3' } }, null, 2) + '\n',
			'README.md': '# BlogPlatform\n\nA minimal blog by a solo developer.\n\n- Next.js 14 with MDX content\n- Prisma + PostgreSQL\n- Tailwind CSS\n- Deployed on Vercel\n',
			'next.config.mjs': "import createMDX from '@next/mdx';\nconst withMDX = createMDX({});\nexport default withMDX({ pageExtensions: ['ts', 'tsx', 'mdx'] });\n",
			'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\nmodel Post {\n  id      String @id @default(cuid())\n  slug    String @unique\n  title   String\n  content String\n}\n',
			'docs/DECISIONS.md': '# Decisions\n\n- Content is authored in MDX.\n- Persistence via Prisma on PostgreSQL.\n- Hosted on Vercel.\n'
		}
	},
	{
		id: 'realestate-api',
		name: 'RealEstate API',
		summary: 'Backend-heavy API - project #3 (S-172).',
		setup: 'RealEstate API: Express.js, MongoDB, JWT auth, AWS Lambda, Serverless Framework. No frontend. OpenAPI spec required for all endpoints.',
		extraTurns: [],
		decisions: [
			{ decision: 'Require an OpenAPI specification for every endpoint', reason: 'Contract-first API design', alternatives: undefined, rejectedAlternatives: [], author: 'developer', decidedAt: '2026-01-03T00:00:00.000Z' }
		],
		events: [],
		files: {
			'package.json': JSON.stringify({ name: 'realestate-api', version: '1.0.0', private: true, dependencies: { express: '4.19.2', mongoose: '8.8.0', jsonwebtoken: '9.0.2', 'serverless-http': '3.2.0' }, devDependencies: { serverless: '3.39.0', typescript: '5.6.3', '@types/express': '4.17.21' } }, null, 2) + '\n',
			'README.md': '# RealEstate API\n\nBackend-only property listing API.\n\n- Express.js on AWS Lambda via the Serverless Framework\n- MongoDB (Mongoose)\n- JWT authentication\n- Every endpoint must be described by an OpenAPI specification (engineering standard)\n',
			'src/handler.ts': "import express from 'express';\nimport serverless from 'serverless-http';\n\nconst app = express();\napp.get('/properties', (_req, res) => res.json([]));\nexport const handler = serverless(app);\n",
			'openapi.yaml': "openapi: 3.0.0\ninfo:\n  title: RealEstate API\n  version: '1.0.0'\npaths:\n  /properties:\n    get:\n      summary: List properties\n      responses:\n        '200':\n          description: OK\n",
			'docs/DECISIONS.md': '# Decisions\n\n- All endpoints require an OpenAPI specification before implementation.\n'
		}
	},
	{
		id: 'mobileapp-bff',
		name: 'MobileApp BFF',
		summary: 'GraphQL backend-for-frontend - project #4 (S-173).',
		setup: 'MobileAppBFF: GraphQL API (not REST), Apollo Server, PostgreSQL with Prisma, Redis cache for queries, JWT with short expiry (15min), React Native frontend connects to this.',
		extraTurns: [],
		decisions: [
			{ decision: 'Use GraphQL instead of REST', reason: 'The mobile client needs flexible query shapes', alternatives: 'REST', rejectedAlternatives: ['REST'], decidedOn: 'GraphQL', author: 'developer', decidedAt: '2026-01-04T00:00:00.000Z' }
		],
		events: [],
		files: {
			'package.json': JSON.stringify({ name: 'mobileapp-bff', version: '0.1.0', private: true, dependencies: { '@apollo/server': '4.11.0', graphql: '16.9.0', '@prisma/client': '5.22.0', redis: '4.7.0', jsonwebtoken: '9.0.2' }, devDependencies: { typescript: '5.6.3' } }, null, 2) + '\n',
			'README.md': '# MobileApp BFF\n\nBackend for the React Native app.\n\n- GraphQL API via Apollo Server (chosen over REST)\n- PostgreSQL with Prisma\n- Redis is used to cache queries\n- JWT sessions expire after 15 minutes (security standard)\n',
			'src/schema.graphql': 'type Query {\n  me: User\n}\n\ntype User {\n  id: ID!\n  email: String!\n}\n',
			'docs/DECISIONS.md': '# Decisions\n\n- GraphQL, not REST, because the mobile client needs flexible queries.\n- JWT expiry is 15 minutes.\n'
		}
	},
	{
		id: 'inventory-system',
		name: 'InventorySystem',
		summary: 'Enterprise-scale test - project #5 (S-187).',
		setup: 'InventorySystem is an enterprise platform: NestJS, PostgreSQL with TypeORM, Redis, Kafka for events, Docker and Kubernetes, observability with Grafana and Prometheus.',
		extraTurns: [],
		decisions: [
			{ decision: 'Use Kafka for inter-service events', reason: 'Decouple services and support replay', alternatives: 'RabbitMQ', rejectedAlternatives: ['RabbitMQ'], decidedOn: 'Kafka', author: 'developer', decidedAt: '2026-01-06T00:00:00.000Z' }
		],
		events: [],
		files: {
			'package.json': JSON.stringify({ name: 'inventory-system', version: '0.1.0', private: true, dependencies: { '@nestjs/core': '10.4.0', '@nestjs/common': '10.4.0', typeorm: '0.3.20', pg: '8.13.0', ioredis: '5.4.1', kafkajs: '2.2.4' }, devDependencies: { typescript: '5.6.3' } }, null, 2) + '\n',
			'README.md': '# InventorySystem\n\nEnterprise inventory platform.\n\n- NestJS microservices\n- PostgreSQL with TypeORM\n- Redis for caching\n- Kafka for inter-service events\n- Docker + Kubernetes\n- Grafana/Prometheus observability\n',
			'src/main.ts': "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nasync function bootstrap() { const app = await NestFactory.create(AppModule); await app.listen(3000); }\nbootstrap();\n",
			'docs/DECISIONS.md': '# Decisions\n\n- Use Kafka for events instead of RabbitMQ, to support replay and decoupling.\n'
		}
	},
	{
		id: 'aistartup-landing',
		name: 'AIStartup Landing',
		summary: 'Frontend-only site - project #6 (S-188).',
		setup: 'AIStartup landing page: Next.js 14, Tailwind CSS, Framer Motion for animation, deployed on Vercel. No backend, no database.',
		extraTurns: [],
		decisions: [],
		events: [],
		files: {
			'package.json': JSON.stringify({ name: 'aistartup-landing', version: '0.1.0', private: true, dependencies: { next: '14.2.0', react: '18.3.0', 'react-dom': '18.3.0', 'framer-motion': '11.11.0', tailwindcss: '3.4.14' }, devDependencies: { typescript: '5.6.3' } }, null, 2) + '\n',
			'README.md': '# AIStartup Landing\n\nMarketing landing page.\n\n- Next.js 14\n- Tailwind CSS\n- Framer Motion animations\n- Vercel deployment\n- No backend and no database\n',
			'app/page.tsx': "export default function Page() { return <main className=\"p-8\">AI Startup</main>; }\n",
			'docs/DECISIONS.md': '# Decisions\n\n- Frontend only; there is no backend and no database.\n'
		}
	}
];
