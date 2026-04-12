import { useEffect, useRef, useState } from "react";

interface WorkspaceWebviewProps {
  src: string;
  onLocationChange: (value: string) => void;
}

export function WorkspaceWebview({ src, onLocationChange }: WorkspaceWebviewProps) {
  const webviewRef = useRef<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview || !src) {
      return;
    }

    setIsLoading(true);
    setError("");

    const handleLoadStart = () => {
      setIsLoading(true);
      setError("");
    };

    const handleLoadStop = () => {
      setIsLoading(false);
      setError("");
    };

    const handleNavigate = (event: { url: string }) => {
      onLocationChange(event.url);
    };

    const handleFail = (event: { errorCode: number; errorDescription?: string }) => {
      if (event.errorCode === -3) {
        return;
      }
      setIsLoading(false);
      setError(event.errorDescription ?? "Falha ao carregar o workspace.");
    };

    webview.addEventListener("did-start-loading", handleLoadStart);
    webview.addEventListener("did-stop-loading", handleLoadStop);
    webview.addEventListener("did-navigate", handleNavigate);
    webview.addEventListener("did-navigate-in-page", handleNavigate);
    webview.addEventListener("did-fail-load", handleFail);

    return () => {
      webview.removeEventListener("did-start-loading", handleLoadStart);
      webview.removeEventListener("did-stop-loading", handleLoadStop);
      webview.removeEventListener("did-navigate", handleNavigate);
      webview.removeEventListener("did-navigate-in-page", handleNavigate);
      webview.removeEventListener("did-fail-load", handleFail);
    };
  }, [onLocationChange, src]);

  return (
    <div className="workspace-stage">
      {isLoading ? <div className="workspace-overlay">Carregando workspace...</div> : null}
      {error ? <div className="workspace-overlay workspace-overlay--error">{error}</div> : null}
      <webview
        ref={webviewRef}
        className="workspace-webview"
        partition="persist:neuros-electron"
        src={src}
        allowpopups
      />
    </div>
  );
}
