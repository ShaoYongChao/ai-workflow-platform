import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
    title: 'AWP 需求工坊',
    description: 'AI 自动化工作流平台 - 策划需求输入系统',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="zh-CN">
            <body>{children}</body>
        </html>
    )
}