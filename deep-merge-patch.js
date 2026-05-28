function deepMerge(target, source) {
  if (source === null || typeof source !== 'object') return source;
  if (Array.isArray(source)) return [...source];
  
  const result = { ...target };
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
          typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  return result;
}

module.exports = { deepMerge };
