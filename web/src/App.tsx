import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import GrAuthGate, { PreviewAuthGate } from './components/GrAuthGate'

const TjPoSystemPage = lazy(() => import('./pages/TjPoSystemPage'))
const CombinePoPage = lazy(() => import('./pages/CombinePoPage'))
const AddItemPage = lazy(() => import('./pages/AddItemPage'))
const ReceiptListPage = lazy(() => import('./pages/ReceiptListPage'))
const ReceiptFormPage = lazy(() => import('./pages/ReceiptFormPage'))
const ReceiptDetailPage = lazy(() => import('./pages/ReceiptDetailPage'))

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
        {/*
          普通采购页面（列表/新建/编辑/合并/商品申请）：
          Preview 需要登录身份（旧表 anon 读写撤销），生产 public 直接放行 —— 不套收货 gate。
        */}
        <Route
          path="/tj-po-system"
          element={<PreviewAuthGate><TjPoSystemPage /></PreviewAuthGate>}
        />
        <Route
          path="/tj-po-system/new"
          element={<PreviewAuthGate><TjPoSystemPage /></PreviewAuthGate>}
        />
        <Route
          path="/tj-po-system/combine"
          element={<PreviewAuthGate><CombinePoPage /></PreviewAuthGate>}
        />
        <Route
          path="/tj-po-system/items"
          element={<PreviewAuthGate><AddItemPage /></PreviewAuthGate>}
        />
        {/* 统一收货：预览环境专用（GrAuthGate 内硬禁用生产 + 登录 + 角色） */}
        <Route
          path="/tj-po-system/receipts"
          element={<GrAuthGate>{(identity, caps) => <ReceiptListPage identity={identity} caps={caps} />}</GrAuthGate>}
        />
        <Route
          path="/tj-po-system/receipts/new"
          element={<GrAuthGate>{(identity, caps) => <ReceiptFormPage identity={identity} caps={caps} />}</GrAuthGate>}
        />
        <Route
          path="/tj-po-system/receipts/:receiptId/edit"
          element={<GrAuthGate>{(identity, caps) => <ReceiptFormPage identity={identity} caps={caps} />}</GrAuthGate>}
        />
        <Route
          path="/tj-po-system/receipts/:receiptId"
          element={<GrAuthGate>{(identity, caps) => <ReceiptDetailPage identity={identity} caps={caps} />}</GrAuthGate>}
        />
        <Route
          path="/tj-po-system/:poId"
          element={<PreviewAuthGate><TjPoSystemPage /></PreviewAuthGate>}
        />
      </Routes>
    </Suspense>
  )
}
