/**
 * The settings seam DSH 0.1.7-rc.1 actually offers, as a test fixture.
 *
 * 0.1.7 deleted `settings.register`: a plugin no longer owns a namespace. The
 * namespace IS the plugin's Loader entry, the index travels as `volatile()`
 * Config fields, the Loader hands them to `apply` as live references, a write
 * goes through `settings.update(entryId, patch)`, and the Loader announces the
 * committed values with `loader/volatile-update`.
 *
 * This fixture reproduces that shape without a profile on disk:
 *
 * - `mountable()` mounts the real plugin module with its real `Config`, so
 *   cordis resolves the schema exactly as the Loader does (volatile fields
 *   become references).
 * - `state.value = document` commits into those same references and announces
 *   the change, which is what the Loader's `_commitVolatile` does after a write.
 * - `state.updates` records every write the plugin made through the service, so
 *   a test can assert the patch and the namespace it went to.
 *
 * @module dsh-prompt-manager/test/helpers/settings-source
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isVolatile, updateVolatile, volatileEntries } from '@deepseek-ai/cosmokit'

/**
 * Import a `@deepseek-ai/*` package, trying this file, the cwd, then `DSH_PACKAGES`.
 * @param packageName - the bare specifier to resolve.
 * @returns the imported module namespace.
 */
export async function load(packageName) {
  const failures = []
  try {
    return await import(packageName)
  } catch (error) {
    failures.push(error.message)
  }
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    return await import(pathToFileURL(require.resolve(packageName)).href)
  } catch (error) {
    failures.push(error.message)
  }
  const root = process.env.DSH_PACKAGES
  if (root !== undefined) {
    const leaf = packageName.slice('@deepseek-ai/'.length)
    return import(pathToFileURL(join(root, leaf, 'lib', 'index.js')).href)
  }
  throw new Error(`cannot resolve ${packageName}; set DSH_PACKAGES to the directory holding @deepseek-ai/* (${failures.join(' | ')})`)
}

/**
 * A config object with every live reference unwrapped, so a fresh one can be
 * resolved from it the way the Loader resolves the profile patch again.
 * @param value - resolved config (or any value inside one).
 * @returns plain JSON-shaped data.
 */
function plain(value) {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  }
  return value
}

/**
 * The live index a mount is currently reading: one entry per volatile field.
 * @param config - the resolved config cordis handed to `apply`.
 * @returns the document, as a settings surface would read it.
 */
function documentOf(config) {
  const document = {}
  for (const { path, ref } of volatileEntries(config)) {
    if (path.length !== 1) continue
    document[path[0]] = ref.get()
  }
  return document
}

/**
 * The settings service and its observable state.
 * @param initial - the document to report before a mount attaches a config.
 * @returns the plugin to mount and the state handle the test drives.
 */
export function fakeSettings(initial = {}) {
  let schema
  let config
  let owner
  let live = initial
  const state = {
    /** Every write the plugin sent, oldest first. */
    updates: [],
    /**
     * Documents the schema refused, oldest first.
     *
     * The Loader contains a refused candidate: `_commitVolatile` logs it and
     * leaves the running references alone, so a hand-edited profile patch that
     * does not validate never reaches the plugin. A fixture that threw here
     * instead would be stricter than the deployment it stands in for.
     */
    refusals: [],
    /** The document the mounted plugin is reading right now. */
    get value() { return config === undefined ? live : documentOf(config) },
    /**
     * Publish a new index the way a committed settings write does: the live
     * references move, then the Loader announces the change.
     * @param next - the document the deployment now holds.
     */
    set value(next) { drive(next) },
    /**
     * Kept so a test written against the old scope watcher still reads as one
     * line: under 0.1.7 nothing in the settings service notifies the owner, so
     * there is nothing to invoke — the commit above is the notification.
     */
    watcher() {},
    /**
     * Bind a mounted plugin's schema, context, and resolved config, so writes
     * and hand-driven documents reach the references that plugin is reading.
     * @param module - the plugin module whose `Config` the Loader resolved.
     * @param ctx - the plugin fiber context, which receives the announcement.
     * @param resolved - the config cordis resolved from the plugin's schema.
     */
    attach(module, ctx, resolved) {
      schema = module.Config
      owner = ctx
      config = resolved
    },
  }

  /**
   * Commit one document into the live references and announce it.
   *
   * A candidate the schema refuses is contained exactly as the Loader contains
   * it: recorded, left out of the running references, and never announced.
   * @param next - the fields the deployment now holds.
   */
  function drive(next) {
    if (config === undefined) {
      live = next
      return
    }
    let fresh
    try {
      fresh = schema({ ...plain(config), ...next })
    } catch (error) {
      state.refusals.push({ document: next, message: String(error?.message ?? error) })
      return
    }
    const paths = []
    for (const { path, ref } of volatileEntries(config)) {
      const source = path.reduce((value, key) => value?.[key], fresh)
      if (source === undefined) continue
      updateVolatile(ref, source)
      paths.push(path)
    }
    owner?.emit('loader/volatile-update', paths)
  }

  const plugin = {
    name: 'fake-settings',
    /** How a mount helper finds this fixture in a plugin list. */
    settingsState: state,
    apply(ctx) {
      ctx.provide('settings', {
        /**
         * The one write path 0.1.7 offers: merge editable fields into the entry's
         * config. The real service persists through the profile patch and the
         * Loader commits the volatile fields, so the fixture commits them too.
         * @param ns - profile entry id.
         * @param patch - fields to merge.
         */
        async update(ns, patch) {
          state.updates.push({ ns, patch: structuredClone(patch) })
          drive(patch)
        },
      })
    },
  }
  return { plugin, state }
}

/**
 * The plugin object to mount: the real module, plus the config capture that
 * lets the fixture commit into the references the module is reading.
 * @param module - the imported plugin module.
 * @param state - the `state` of a {@link fakeSettings} fixture, when the test
 *   mounts one. Omitted for a mount that should have no settings service.
 * @returns a plugin object for `ctx.plugin`.
 */
export function mountable(module, state) {
  return {
    name: module.name,
    inject: module.inject,
    Config: module.Config,
    apply(ctx, config) {
      state?.attach(module, ctx, config)
      return module.apply(ctx, config)
    },
  }
}
