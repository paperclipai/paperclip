'use client'

import { useState } from 'react'
import { Share2, Link2, Printer, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ShareProofResult } from '@/lib/types'

interface ShareProofButtonProps {
  onShare: () => Promise<ShareProofResult | null>
  vaultId: string
}

export function ShareProofButton({ onShare, vaultId }: ShareProofButtonProps) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [shareResult, setShareResult] = useState<ShareProofResult | null>(null)
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handleShare = async () => {
    setState('loading')
    setErrorMsg('')
    try {
      const result = await onShare()
      setShareResult(result)
      setState('done')
      setOpen(true)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to share')
      setState('error')
    }
  }

  const copyLink = async () => {
    if (!shareResult) return
    await navigator.clipboard.writeText(shareResult.shareUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const printProof = () => {
    window.print()
  }

  const reset = () => {
    setState('idle')
    setOpen(false)
    setShareResult(null)
    setErrorMsg('')
  }

  return (
    <div className="relative">
      {!open ? (
        <button
          type="button"
          onClick={handleShare}
          disabled={state === 'loading'}
          className={cn(
            'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
            'retro-active disabled:opacity-60 disabled:cursor-not-allowed',
            'hover:scale-[1.02] active:scale-[0.98]'
          )}
        >
          {state === 'loading' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Share2 className="w-4 h-4" />
          )}
          {state === 'loading' ? 'Generating…' : 'Share Proof'}
        </button>
      ) : (
        <div className="retro-surface rounded-xl p-4 min-w-[340px] space-y-3 absolute right-0 top-0 z-10">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Proof link generated</span>
            <button
              type="button"
              onClick={reset}
              className="p-1 rounded hover:bg-white/10 text-muted-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {shareResult && (
            <>
              <div className="flex items-center gap-2 bg-black/30 rounded-lg px-3 py-2">
                <code className="text-xs font-mono text-cyan-300 flex-1 truncate">
                  {shareResult.shareUrl}
                </code>
                <button
                  type="button"
                  onClick={copyLink}
                  className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors text-muted-foreground hover:text-foreground"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Link2 className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>

              <p className="text-xs text-muted-foreground/70">
                Link valid until{' '}
                <span className="text-muted-foreground">
                  {new Date(shareResult.expiresAt).toLocaleDateString()}
                </span>
              </p>
            </>
          )}

          <button
            type="button"
            onClick={printProof}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
          >
            <Printer className="w-3.5 h-3.5" />
            Export as PDF (browser print)
          </button>
        </div>
      )}

      {state === 'error' && (
        <p className="text-xs text-red-400 mt-1">{errorMsg}</p>
      )}
    </div>
  )
}
