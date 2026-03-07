'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { HttpAgent } from '@dfinity/agent'
import { createAgent, getICPNetworkConfig, type ICPConnectionConfig } from '@/lib/icp-connection'

interface ICContextValue {
  agent: HttpAgent | null
  isConnected: boolean
  config: ICPConnectionConfig | null
  connect: (config?: Partial<ICPConnectionConfig>) => Promise<void>
  disconnect: () => void
}

const ICContext = createContext<ICContextValue | undefined>(undefined)

export function ICProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<HttpAgent | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [config, setConfig] = useState<ICPConnectionConfig | null>(null)

  useEffect(() => {
    const initAgent = async () => {
      try {
        const newConfig = getICPNetworkConfig()
        const newAgent = await createAgent(newConfig)
        setAgent(newAgent)
        setConfig(newConfig)
        setIsConnected(true)
      } catch (_error) {
        console.error('Failed to initialize ICP agent:', _error)
        setIsConnected(false)
      }
    }

    initAgent()
  }, [])

  const connect = async (newConfigParam?: Partial<ICPConnectionConfig>) => {
    try {
      const mergedConfig = newConfigParam ? { ...getICPNetworkConfig(), ...newConfigParam } : getICPNetworkConfig()
      const newAgent = await createAgent(mergedConfig)
      setAgent(newAgent)
      setConfig(mergedConfig)
      setIsConnected(true)
    } catch (_error) {
      console.error('Failed to connect to ICP:', _error)
      setIsConnected(false)
    }
  }

  const disconnect = () => {
    setAgent(null)
    setIsConnected(false)
    setConfig(null)
  }

  return (
    <ICContext.Provider value={{ agent, isConnected, config, connect, disconnect }}>
      {children}
    </ICContext.Provider>
  )
}

export function useIC() {
  const context = useContext(ICContext)
  if (!context) {
    throw new Error('useIC must be used within ICProvider')
  }
  return context
}
