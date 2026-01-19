const fs = require('fs');
const content = fs.readFileSync('extension/andi/andi.js', 'utf8');
try {
  new Function(content);
  console.log("Syntax OK");
} catch (e) {
  console.log(e);
}
