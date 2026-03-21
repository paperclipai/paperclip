const fs = require('fs');
const showdown = require('showdown');

const converter = new showdown.Converter();

fs.readFile('input.md', 'utf8', (err, data) => {
  if (err) {
    console.error("Error reading input.md:", err);
    return;
  }

  const html = converter.makeHtml(data);

  fs.writeFile('output.html', html, (err) => {
    if (err) {
      console.error("Error writing output.html:", err);
      return;
    }
    console.log("Successfully converted input.md to output.html");
  });
});
