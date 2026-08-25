/*---------------------------------------------------------------------------------------------
 *  Copyright (c) CodeMind. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import {
    Capability, IntentClassification, SelectionContext, ToolAdapter,
    ToolAdapterRegistry, ToolSelectionDecision, ToolSelectionResult,
} from './types.js';
import { resolveRequiredCapabilities } from './capabilities.js';

/**
 * Tool Selection Engine (Section 3) — capability-based.
 *
 * Selection has NO per-intent adapter list and NO switch over adapter ids. It:
 *   1. asks capabilities.ts for the ORDERED capabilities the intent+context need;
 *   2. resolves each capability to whatever registered adapter ADVERTISES it
 *      (adapter.capabilities), in required-capability order;
 *   3. lets each candidate adapter's own shouldRun() veto itself.
 * A new adapter becomes eligible purely by advertising a capability — no edit here.
 */

/** All adapters in the registry, in insertion order. */
function adaptersOf(registry: ToolAdapterRegistry): ToolAdapter[] {
    return Array.from(registry.values());
}

function advertises(adapter: ToolAdapter, cap: Capability): boolean {
    return (adapter.capabilities ?? []).includes(cap);
}

/**
 * Full capability-based selection with an auditable decision per registered
 * adapter (selected or skipped, with the reason). This is the honest core used
 * by the trace; `selectTools` is the thin ordered-list wrapper the pipeline uses.
 */
export function selectToolsWithReasons(
    intent: IntentClassification,
    context: SelectionContext,
    registry: ToolAdapterRegistry,
): ToolSelectionResult {
    const required = resolveRequiredCapabilities(intent, context);
    const all = adaptersOf(registry);

    const selected: ToolAdapter[] = [];
    const selectedIds = new Set<string>();
    const satisfied: Capability[] = [];
    const unmet: Capability[] = [];

    // Resolve each required capability, in order, to the first advertising
    // adapter that isn't vetoed. Order of `selected` therefore follows the
    // order of `required` — deterministic and independent of adapter internals.
    for (const cap of required) {
        const providers = all.filter(a => advertises(a, cap));
        if (providers.length === 0) {
            unmet.push(cap); // nothing in this registry can provide it
            continue;
        }
        if (providers.some(a => selectedIds.has(a.id))) {
            satisfied.push(cap); // already covered by an earlier pick
            continue;
        }
        const runnable = providers.find(a => a.shouldRun(intent, context));
        if (runnable) {
            selected.push(runnable);
            selectedIds.add(runnable.id);
            satisfied.push(cap);
        } else {
            unmet.push(cap); // a provider exists but its shouldRun() vetoed
        }
    }

    const decisions: ToolSelectionDecision[] = all.map(a => {
        const advertised = a.capabilities ?? [];
        const matched = required.filter(c => advertised.includes(c));
        const isSelected = selectedIds.has(a.id);
        let reason: string;
        if (isSelected) {
            reason = `selected — provides ${matched.join(', ')}`;
        } else if (matched.length === 0) {
            reason = `skipped — advertises [${advertised.join(', ') || 'nothing'}]; intent requires none of them`;
        } else if (!a.shouldRun(intent, context)) {
            reason = `skipped — could provide ${matched.join(', ')} but shouldRun() vetoed for this context`;
        } else {
            reason = `skipped — ${matched.join(', ')} already satisfied by an earlier adapter`;
        }
        return { adapterId: a.id, selected: isSelected, advertisedCapabilities: advertised, matchedCapabilities: matched, reason };
    });

    return {
        selected,
        decisions,
        requiredCapabilities: required,
        satisfiedCapabilities: satisfied.filter((c, i) => satisfied.indexOf(c) === i),
        unmetCapabilities: unmet.filter((c, i) => unmet.indexOf(c) === i),
    };
}

/**
 * Ordered list of adapters to run for this intent+context. Backward-compatible
 * signature; internally delegates to the capability-based resolver above.
 */
export function selectTools(
    intent: IntentClassification,
    context: SelectionContext,
    registry: ToolAdapterRegistry,
): ToolAdapter[] {
    return selectToolsWithReasons(intent, context, registry).selected;
}

