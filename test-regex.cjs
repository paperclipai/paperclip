const fs = require("fs");
const path = require("path");

const content = fs.readFileSync("C:\\Users\\frisa\\AppData\\Roaming\\npm\\gemini.CMD", "utf8");
const match = content.match(/(?:"%_prog%"|node)\s+"(?:%~dp0|%dp0%)\\([^"]+\.js)"/i);
if (match) {
  console.log("MATCH FOUND!");
  console.log("Relative Path:", match[1]);
  console.log("Absolute Path:", path.join(path.dirname("C:\\Users\\frisa\\AppData\\Roaming\\npm\\gemini.CMD"), match[1]));
} else {
  console.log("NO MATCH");
}
