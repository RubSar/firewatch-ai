/**
 * Fire spread simulation core.
 *
 * Deliberately free of DOM and Node APIs so the identical stepping code runs in
 * the browser (offline mode) and on the server (streaming mode). Anything that
 * touches a canvas, an <img>, or the filesystem belongs in a provider, not here.
 */
export * from './fuels.ts'
export * from './noise.ts'
export * from './terrain.ts'
export * from './weather.ts'
export * from './geo.ts'
export * from './classify.ts'
export * from './model.ts'
