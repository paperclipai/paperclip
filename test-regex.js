const content = require('fs').readFileSync('C:/Users/frisa/AppData/Roaming/npm/gemini.CMD', 'utf8');
const match = content.match(/(?:"%_prog%"|node)\s+"(?:%~dp0|%dp0%)\\([^"]+\.js)"/i);
console.log('MATCH:', match);
