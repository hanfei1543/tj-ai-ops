// 类型声明（实现见 xlsx.js）
export interface SheetColumn {
  header: string
  key: string
  width?: number
}

export interface SheetSpec {
  name: string
  columns?: ReadonlyArray<SheetColumn>
  rows?: ReadonlyArray<Record<string, unknown>>
}

export declare const XLSX_MIME: string
export declare function buildWorkbook(sheets: readonly SheetSpec[]): Promise<Blob>
