import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

const TjPoSystemPage = lazy(() => import('./pages/TjPoSystemPage'))

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <div className="text-slate-500">Loading...</div>
        </div>
      }
    >
      <Routes>
        <Route path="/" element={<Navigate to="/tj-po-system" replace />} />
        <Route path="/tj-po-system" element={<TjPoSystemPage />} />
        <Route path="/tj-po-system/new" element={<TjPoSystemPage />} />
        <Route path="/tj-po-system/:poId" element={<TjPoSystemPage />} />
      </Routes>
    </Suspense>
  )
}
