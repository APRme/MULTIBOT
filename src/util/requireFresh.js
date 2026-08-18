function requireFresh(modulePath) {
  const resolvedPath = require.resolve(modulePath);
  delete require.cache[resolvedPath];
  return require(resolvedPath);
}

module.exports = {
  requireFresh
};
