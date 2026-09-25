/**
 * A loader hook that makes `@deepseek-ai/schemastery` unresolvable to this
 * plugin's host half, standing in for a deployment without the settings
 * capability.
 *
 * The plugin resolves its schema factory through the ESM graph, so this is the
 * seam that decides whether a factory is reachable at all. The denial is scoped
 * to the module under test — DSH's own packages use schemastery for their Config
 * schemas, and the test still has to mount the plugin into a real registry
 * afterwards, so a process-wide denial would break the mount instead of the
 * factory lookup.
 *
 * @module dsh-prompt-manager/test/helpers/no-schemastery
 */

/** The importer whose schemastery lookups fail: this package's host half. */
const DENIED_IMPORTER = '/dsh-prompt-manager/lib/index.js'

/**
 * Refuse schemastery to the module under test; resolve everything else normally.
 * @param specifier - the requested specifier.
 * @param context - Node's resolution context, whose `parentURL` is the importer.
 * @param nextResolve - the next resolver in the chain.
 * @returns the resolution of anything the denial does not cover.
 */
export async function resolve(specifier, context, nextResolve) {
  const importer = String(context?.parentURL ?? '').split('?')[0]
  if (String(specifier).includes('schemastery') && importer.endsWith(DENIED_IMPORTER)) {
    throw new Error(`Cannot find package "${String(specifier)}" (no settings capability in this deployment)`)
  }
  return nextResolve(specifier, context)
}
