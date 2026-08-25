/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { DeveloperIntent } from './types.js';

/**
 * Representative intent benchmark (Phase-2 re-evaluation, Layer 1).
 *
 * This is the ground truth the local second-stage classifier is TUNED against —
 * not hand-picked thresholds. Every case is a real developer phrasing labelled
 * with the intent it should route to. It deliberately spans, per intent:
 *   normal · alternate verbs · polite · question form · short · long ·
 *   with a technical name · without one · ambiguous · multi-intent.
 *
 * `group` marks SEMANTIC-EQUIVALENCE sets: every case sharing a group id must
 * route to the same intent (and therefore the same capabilities) regardless of
 * wording — that is the "Add Clerk" ≡ "Please wire Clerk in" requirement.
 *
 * `tags` carry the coverage dimension and, importantly, mark the exact prompts
 * the re-evaluation called out as currently mis-handled by pure keywords
 * ('currently-failing'), so a test can assert each one is now routed correctly.
 *
 * `ambiguous: true` means the prompt is genuinely under-specified; the test for
 * it asserts a SAFE capability set (via the labelled intent), never a universal
 * grab-bag.
 */
export interface BenchmarkCase {
    prompt: string;
    intent: DeveloperIntent;
    /** Semantic-equivalence group — same group ⇒ same intent, any wording. */
    group?: string;
    tags?: string[];
    /** Genuinely under-specified prompt (assert a safe capability set). */
    ambiguous?: boolean;
}

const I = DeveloperIntent;

export const INTENT_BENCHMARK: BenchmarkCase[] = [
    // ---- CODE_GENERATION: clerk-integration semantic-equivalence group ----
    { prompt: 'Implement user authentication with Clerk', intent: I.CODE_GENERATION, group: 'clerk', tags: ['normal', 'named'] },
    { prompt: 'Add Clerk authentication', intent: I.CODE_GENERATION, group: 'clerk', tags: ['named', 'currently-failing'] },
    { prompt: 'Please add Clerk to the project', intent: I.CODE_GENERATION, group: 'clerk', tags: ['polite', 'named'] },
    { prompt: 'Can you add Clerk auth?', intent: I.CODE_GENERATION, group: 'clerk', tags: ['question', 'named'] },
    { prompt: 'Set up Clerk for us', intent: I.CODE_GENERATION, group: 'clerk', tags: ['alt-verb', 'named'] },
    { prompt: 'Integrate Clerk into the login flow', intent: I.CODE_GENERATION, group: 'clerk', tags: ['alt-verb', 'named'] },
    { prompt: 'Please wire Clerk into the login flow', intent: I.CODE_GENERATION, group: 'clerk', tags: ['polite', 'alt-verb', 'named'] },

    // ---- CODE_GENERATION: login-flow semantic-equivalence group ----
    { prompt: 'Create a login flow', intent: I.CODE_GENERATION, group: 'login-flow', tags: ['normal'] },
    { prompt: 'Please create a login flow', intent: I.CODE_GENERATION, group: 'login-flow', tags: ['polite', 'currently-failing'] },
    { prompt: 'Build a login screen for the app', intent: I.CODE_GENERATION, group: 'login-flow', tags: ['alt-verb', 'long'] },
    { prompt: 'Add a sign-in page', intent: I.CODE_GENERATION, group: 'login-flow', tags: ['alt-verb'] },

    // ---- CODE_GENERATION: general ----
    { prompt: 'Write a function that validates email addresses', intent: I.CODE_GENERATION, tags: ['normal'] },
    { prompt: 'Generate a React component for the sidebar', intent: I.CODE_GENERATION, tags: ['normal', 'named'] },
    { prompt: 'Make a REST endpoint for user profiles', intent: I.CODE_GENERATION, tags: ['alt-verb'] },
    { prompt: 'develop a caching layer for the API', intent: I.CODE_GENERATION, tags: ['alt-verb', 'long'] },
    { prompt: 'Create a Python script to rename files in a folder', intent: I.CODE_GENERATION, tags: ['normal', 'long'] },
    { prompt: 'Add a dark mode toggle to the settings page', intent: I.CODE_GENERATION, tags: ['normal'] },
    { prompt: 'Implement pagination for the products list', intent: I.CODE_GENERATION, tags: ['normal'] },
    { prompt: 'Build a webhook handler for Stripe events', intent: I.CODE_GENERATION, tags: ['alt-verb', 'named'] },
    { prompt: 'Scaffold a new Express server with routing', intent: I.CODE_GENERATION, tags: ['alt-verb', 'named'] },
    { prompt: 'Write a utility to debounce input events', intent: I.CODE_GENERATION, tags: ['normal'] },
    { prompt: 'Can you wire this up?', intent: I.CODE_GENERATION, tags: ['question', 'short', 'currently-failing'], ambiguous: true },

    // ---- MEMORY_RETRIEVAL ----
    { prompt: 'What database are we using?', intent: I.MEMORY_RETRIEVAL, tags: ['question'], ambiguous: true },
    { prompt: 'Which auth provider did we choose?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'named'] },
    { prompt: 'Remind me why we picked Postgres', intent: I.MEMORY_RETRIEVAL, tags: ['normal', 'named'] },
    { prompt: 'What framework are we on again?', intent: I.MEMORY_RETRIEVAL, tags: ['question'] },
    { prompt: 'Do you remember what state library we settled on?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'long'] },
    { prompt: 'What did we decide about the API structure earlier?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'long'] },
    { prompt: 'Which package manager are we standardized on?', intent: I.MEMORY_RETRIEVAL, tags: ['question'] },
    { prompt: 'What was our reasoning for dropping Redux?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'named'] },
    { prompt: 'Remind me which cloud provider we deployed to', intent: I.MEMORY_RETRIEVAL, tags: ['normal'] },
    { prompt: 'What convention did we agree on for file naming?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'long'] },
    { prompt: 'Which testing framework did the team pick?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'named'] },
    { prompt: 'What did we settle on for styling earlier?', intent: I.MEMORY_RETRIEVAL, tags: ['question'] },
    { prompt: 'Which version of Node did we standardize on for this project?', intent: I.MEMORY_RETRIEVAL, tags: ['question', 'long', 'named'] },

    // ---- ARCHITECTURE ----
    { prompt: 'Give me a high-level overview of the system design', intent: I.ARCHITECTURE, tags: ['normal', 'long'] },
    { prompt: 'How is the project structured?', intent: I.ARCHITECTURE, tags: ['question'] },
    { prompt: 'Should we switch the database?', intent: I.ARCHITECTURE, tags: ['question', 'currently-failing'], ambiguous: true },
    { prompt: 'Should we migrate to a different database?', intent: I.ARCHITECTURE, tags: ['question', 'alt-verb'] },
    { prompt: 'Walk me through the module layout', intent: I.ARCHITECTURE, tags: ['alt-verb'] },
    { prompt: 'What is the overall architecture here?', intent: I.ARCHITECTURE, tags: ['question'] },
    { prompt: 'Design the folder structure for a new service', intent: I.ARCHITECTURE, tags: ['normal', 'long'] },
    { prompt: 'Explain the high-level design of the payment system', intent: I.ARCHITECTURE, tags: ['normal', 'long'] },
    { prompt: 'How should we organize the shared components?', intent: I.ARCHITECTURE, tags: ['question'] },
    { prompt: 'What is the big picture of how these services talk?', intent: I.ARCHITECTURE, tags: ['question', 'long'] },
    { prompt: 'Lay out the module structure for the new feature', intent: I.ARCHITECTURE, tags: ['alt-verb', 'long'] },
    { prompt: 'Describe the system design at a high level', intent: I.ARCHITECTURE, tags: ['alt-verb'] },

    // ---- WEB_SEARCH ----
    { prompt: 'Search for the latest Clerk pricing', intent: I.WEB_SEARCH, group: 'clerk-pricing', tags: ['normal', 'named'] },
    { prompt: 'Look up the current Next.js version', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'Find the newest React release notes', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'What is the current price of the OpenAI API?', intent: I.WEB_SEARCH, tags: ['question', 'named'] },
    { prompt: 'Get information about Stripe webhooks', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'Search the web for Tailwind v4 migration docs', intent: I.WEB_SEARCH, tags: ['normal', 'named'] },
    { prompt: 'Look up the latest LTS version of Node', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'Find the current documentation for Prisma migrations', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named', 'long'] },
    { prompt: 'What is the latest stable Postgres release?', intent: I.WEB_SEARCH, tags: ['question', 'named'] },
    { prompt: 'Fetch the changelog for the latest TypeScript', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'Look up current AWS Lambda pricing tiers', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },
    { prompt: 'Find the newest security advisories for Express', intent: I.WEB_SEARCH, tags: ['alt-verb', 'named'] },

    // ---- GIT_OPERATIONS ----
    { prompt: 'Commit these changes with a clear message', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Push my branch to origin', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Show me what changed since the previous commit', intent: I.GIT_OPERATIONS, tags: ['alt-verb', 'currently-failing'] },
    { prompt: 'Create a new branch for the feature', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Stage and commit the modified files', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Rebase this branch onto main', intent: I.GIT_OPERATIONS, tags: ['alt-verb'] },
    { prompt: 'Merge the develop branch into main', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Show the git diff for the staged files', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Stash my current changes', intent: I.GIT_OPERATIONS, tags: ['short'] },
    { prompt: 'Revert the last commit', intent: I.GIT_OPERATIONS, tags: ['normal'] },
    { prompt: 'Cherry-pick that fix onto the release branch', intent: I.GIT_OPERATIONS, tags: ['alt-verb', 'long'] },
    { prompt: 'Pull the latest changes from upstream', intent: I.GIT_OPERATIONS, tags: ['normal'] },

    // ---- TERMINAL_EXECUTION ----
    { prompt: 'Run npm install', intent: I.TERMINAL_EXECUTION, tags: ['normal'] },
    { prompt: 'npm run build', intent: I.TERMINAL_EXECUTION, tags: ['short'] },
    { prompt: 'Start the dev server', intent: I.TERMINAL_EXECUTION, tags: ['normal'] },
    { prompt: 'Execute the build script now', intent: I.TERMINAL_EXECUTION, tags: ['alt-verb'] },
    { prompt: 'pnpm run lint', intent: I.TERMINAL_EXECUTION, tags: ['short'] },
    { prompt: 'Kill the process on port 3000', intent: I.TERMINAL_EXECUTION, tags: ['normal'] },
    { prompt: 'Run the migration script', intent: I.TERMINAL_EXECUTION, tags: ['normal'] },
    { prompt: 'Execute cargo build in release mode', intent: I.TERMINAL_EXECUTION, tags: ['alt-verb', 'named'] },
    { prompt: 'Start the docker containers', intent: I.TERMINAL_EXECUTION, tags: ['normal', 'named'] },
    { prompt: 'Launch the app in development mode', intent: I.TERMINAL_EXECUTION, tags: ['alt-verb'] },
    { prompt: 'Run the database seed command', intent: I.TERMINAL_EXECUTION, tags: ['normal'] },
    { prompt: 'Execute the deployment script', intent: I.TERMINAL_EXECUTION, tags: ['alt-verb'] },

    // ---- DOCUMENTATION ----
    { prompt: 'Document this module in the README', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Add comments explaining this function', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Write docs for the auth flow', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Explain how this middleware works', intent: I.DOCUMENTATION, tags: ['question', 'long'] },
    { prompt: 'Update the README with setup steps', intent: I.DOCUMENTATION, tags: ['alt-verb'] },
    { prompt: 'Add JSDoc comments to the exported functions', intent: I.DOCUMENTATION, tags: ['normal', 'named'] },
    { prompt: 'Write a usage guide for the CLI', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Document the configuration options', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Add inline comments to clarify this algorithm', intent: I.DOCUMENTATION, tags: ['normal', 'long'] },
    { prompt: 'Write API documentation for the endpoints', intent: I.DOCUMENTATION, tags: ['normal'] },
    { prompt: 'Draft a README section on environment variables', intent: I.DOCUMENTATION, tags: ['alt-verb', 'long'] },
    { prompt: 'Add a docstring describing this class', intent: I.DOCUMENTATION, tags: ['normal'] },

    // ---- DEBUGGING ----
    { prompt: 'Why is this middleware failing?', intent: I.DEBUGGING, tags: ['question', 'currently-failing'], ambiguous: true },
    { prompt: 'Fix the bug that crashes on startup', intent: I.DEBUGGING, tags: ['normal'] },
    { prompt: 'This throws a null pointer exception, help', intent: I.DEBUGGING, tags: ['normal', 'long'] },
    { prompt: 'The build is broken, what is wrong?', intent: I.DEBUGGING, tags: ['question'] },
    { prompt: 'Why does my request return a 500 error?', intent: I.DEBUGGING, tags: ['question', 'long'] },
    { prompt: 'The app crashes when I click submit, debug it', intent: I.DEBUGGING, tags: ['normal', 'long'] },
    { prompt: 'Getting a segfault, help me track it down', intent: I.DEBUGGING, tags: ['normal'] },
    { prompt: 'The API returns undefined, what is going wrong?', intent: I.DEBUGGING, tags: ['question', 'long'] },
    { prompt: 'My component is not re-rendering, fix it', intent: I.DEBUGGING, tags: ['normal'] },
    { prompt: 'The deployment keeps failing, what broke?', intent: I.DEBUGGING, tags: ['question'] },
    { prompt: 'Diagnose the memory leak in the worker', intent: I.DEBUGGING, tags: ['alt-verb'] },
    { prompt: 'Why am I getting a CORS error on every request?', intent: I.DEBUGGING, tags: ['question', 'long'] },

    // ---- CODE_REVIEW ----
    { prompt: 'Review this code for issues', intent: I.CODE_REVIEW, tags: ['normal'] },
    { prompt: 'Refactor this function to be cleaner', intent: I.CODE_REVIEW, tags: ['alt-verb'] },
    { prompt: 'Check this for correctness', intent: I.CODE_REVIEW, tags: ['normal'] },
    { prompt: 'Can you improve this implementation?', intent: I.CODE_REVIEW, tags: ['question'] },
    { prompt: 'Optimize this loop for performance', intent: I.CODE_REVIEW, tags: ['alt-verb', 'long'] },
    { prompt: 'Is this the right way to handle errors here?', intent: I.CODE_REVIEW, tags: ['question', 'long'] },
    { prompt: 'Clean up this messy component', intent: I.CODE_REVIEW, tags: ['alt-verb'] },
    { prompt: 'Give me feedback on this pull request', intent: I.CODE_REVIEW, tags: ['normal'] },
    { prompt: 'Simplify this conditional logic', intent: I.CODE_REVIEW, tags: ['alt-verb'] },
    { prompt: 'Make this code more readable', intent: I.CODE_REVIEW, tags: ['alt-verb'] },
    { prompt: 'Any issues with how I structured this class?', intent: I.CODE_REVIEW, tags: ['question', 'long'] },

    // ---- TESTING ----
    { prompt: 'Write tests for the parser', intent: I.TESTING, tags: ['normal'] },
    { prompt: 'Add unit tests for the login module', intent: I.TESTING, tags: ['normal'] },
    { prompt: 'Run the tests and tell me what failed', intent: I.TESTING, tags: ['long', 'currently-failing'] },
    { prompt: 'Increase test coverage for the utils', intent: I.TESTING, tags: ['alt-verb'] },
    { prompt: 'Add integration tests for the API', intent: I.TESTING, tags: ['normal', 'named'] },
    { prompt: 'Write a test case for the edge condition', intent: I.TESTING, tags: ['normal'] },
    { prompt: 'Add snapshot tests for the components', intent: I.TESTING, tags: ['normal', 'named'] },
    { prompt: 'Cover the error paths with unit tests', intent: I.TESTING, tags: ['alt-verb', 'long'] },
    { prompt: 'Write end-to-end tests for the checkout flow', intent: I.TESTING, tags: ['normal', 'long'] },
    { prompt: 'Add a regression test for that bug', intent: I.TESTING, tags: ['normal'] },
    { prompt: 'Write tests to verify the validation rules', intent: I.TESTING, tags: ['normal', 'long'] },
    { prompt: 'Add test coverage for the auth guard', intent: I.TESTING, tags: ['normal'] },

    // ---- PROJECT_ANALYSIS ----
    { prompt: 'Analyze the project dependencies and tech stack', intent: I.PROJECT_ANALYSIS, tags: ['normal', 'long'] },
    { prompt: 'Summarize the project and give me metrics', intent: I.PROJECT_ANALYSIS, tags: ['normal'] },
    { prompt: 'What tech stack does this project use?', intent: I.PROJECT_ANALYSIS, tags: ['question'] },
    { prompt: 'Give me stats about the codebase', intent: I.PROJECT_ANALYSIS, tags: ['alt-verb'] },
    { prompt: 'How many lines of code are in this repo?', intent: I.PROJECT_ANALYSIS, tags: ['question'] },
    { prompt: 'List the outdated dependencies', intent: I.PROJECT_ANALYSIS, tags: ['normal'] },
    { prompt: 'What frameworks and libraries does this project rely on?', intent: I.PROJECT_ANALYSIS, tags: ['question', 'long'] },
    { prompt: 'Break down the codebase by language', intent: I.PROJECT_ANALYSIS, tags: ['alt-verb'] },
    { prompt: 'Give me metrics on the project size and dependencies', intent: I.PROJECT_ANALYSIS, tags: ['normal', 'long'] },
    { prompt: 'What is the dependency footprint of this project?', intent: I.PROJECT_ANALYSIS, tags: ['question'] },

    // ---- MULTI_TOOL_WORKFLOW (genuinely compound tasks) ----
    { prompt: 'Build auth using Clerk and also check the latest Clerk pricing', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'named', 'long'] },
    { prompt: 'Search the latest Clerk pricing and update the auth module', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'named', 'currently-failing'] },
    { prompt: 'Fix the failing tests and commit the changes', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'long'] },
    { prompt: 'Add a login form and write tests for it', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi'] },
    { prompt: 'Refactor the parser and then run the tests', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'long'] },
    { prompt: 'Look up the current React version and upgrade the dependency', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'named', 'long'] },
    { prompt: 'Write the API endpoint and document it in the README', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'long'] },
    { prompt: 'Debug the crash and then push the fix', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi'] },
    { prompt: 'Analyze the dependencies and update the outdated ones', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'long'] },
    { prompt: 'Create a migration and run it against the dev database', intent: I.MULTI_TOOL_WORKFLOW, tags: ['multi', 'long'] },
];

/** Distinct intents that appear as labels in the benchmark. */
export function benchmarkIntents(): DeveloperIntent[] {
    return Array.from(new Set(INTENT_BENCHMARK.map(c => c.intent)));
}

/** Cases sharing a semantic-equivalence group id (>=2 members). */
export function equivalenceGroups(): Map<string, BenchmarkCase[]> {
    const m = new Map<string, BenchmarkCase[]>();
    for (const c of INTENT_BENCHMARK) {
        if (!c.group) { continue; }
        (m.get(c.group) ?? m.set(c.group, []).get(c.group)!).push(c);
    }
    for (const [k, v] of m) { if (v.length < 2) { m.delete(k); } }
    return m;
}

/** Cases the re-evaluation flagged as mishandled by pure keyword scoring. */
export function currentlyFailingCases(): BenchmarkCase[] {
    return INTENT_BENCHMARK.filter(c => c.tags?.includes('currently-failing'));
}

