// Separate unfiltered path for MiniBlend's mesh and texture references.
// This bypasses the legacy /rbxasset rewrite which may still be cached or
// mapped to an older mesh-only handler in an existing deployment.
module.exports = require('./rbxasset');
