/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Neo4j constraint/index bootstrap (P1-T02, spec §6.5/§6.6).
 *
 * The statement list comes from the ontology (baseline implementation decision: unique
 * identity per node type plus project-scoping indexes). Exercised from M3 when the graph
 * repository is wired; kept type-only here so no driver is bundled until then.
 */

import neo4j, { type Driver } from 'neo4j-driver';
import { loadPpbConfig, type PpbConfig } from '../config.js';
import { graphConstraintStatements } from '../ontology.js';

/** Short connect timeout so a missing graph degrades fast (spec §24). PLACEHOLDER (§26/§32). */
const CONNECTION_TIMEOUT_MS = 5_000;

/** The only place a Neo4j driver is constructed (spec §6.7 repository abstraction). */
export function createNeo4jDriver(config: PpbConfig = loadPpbConfig()): Driver {
	return neo4j.driver(
		config.neo4jUrl,
		neo4j.auth.basic(config.neo4jUser, config.neo4jPassword),
		{ connectionTimeout: CONNECTION_TIMEOUT_MS }
	);
}

export async function applyGraphConstraints(driver: Driver): Promise<readonly string[]> {
	const statements = graphConstraintStatements();
	const session = driver.session();
	try {
		for (const statement of statements) {
			await session.run(statement);
		}
	} finally {
		await session.close();
	}
	return statements;
}
