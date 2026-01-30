import { useEffect, useState } from 'react'
import PDFProcessor from './pages/PDFProcessor'
import Login from './pages/Login'
import { AUTH_STORAGE_KEY } from './const/appConstants'
import './App.css'

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (stored === '1') {
      setIsAuthenticated(true)
    }
  }, [])

  const handleAuthenticated = () => {
    setIsAuthenticated(true)
  }

  const handleLogout = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
    }
    setIsAuthenticated(false)
  }

  if (!isAuthenticated) {
    return <Login onAuthenticated={handleAuthenticated} />
  }

  return <PDFProcessor onLogout={handleLogout} />
}

export default App
