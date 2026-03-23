import { useState, useRef, useEffect } from 'react';
import { marked } from 'marked';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';
import './App.css';

// Create a new marked instance with sanitized options
const renderer = new marked.Renderer();
marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
  // sanitize: true, // DEPRECATED: This option is no longer supported.
});

function App() {
  const [markdown, setMarkdown] = useState('# Hello, world!');
  const [html, setHtml] = useState('');
  const [copied, setCopied] = useState(false);
  const htmlOutputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const convertMarkdown = async () => {
      const result = await marked(markdown);
      setHtml(result);
    };
    convertMarkdown();
  }, [markdown]);

  const handleCopy = () => {
    navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadPdf = () => {
    if (htmlOutputRef.current) {
      html2canvas(htmlOutputRef.current).then((canvas) => {
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF();
        const imgProps = pdf.getImageProperties(imgData);
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
        pdf.save('download.pdf');
      });
    }
  };

  return (
    <div className="app">
      <header>
        <h1>Markdown to HTML Converter</h1>
      </header>
      <main>
        <div className="markdown-input-container">
          <textarea
            className="markdown-input"
            value={markdown}
            onChange={(e) => {
              setMarkdown(e.target.value);
            }}
          />
        </div>
        <div className="html-output-container">
          <div className="button-container">
            <button className="copy-button" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy HTML'}
            </button>
            <button className="download-button" onClick={handleDownloadPdf}>
              Download PDF
            </button>
          </div>
          <div
            className="html-output"
            dangerouslySetInnerHTML={{ __html: html }}
            ref={htmlOutputRef}
          />
        </div>
      </main>
    </div>
  );
}

export default App;
