import pino from 'pino'
export const logger = pino({
  name: 'executor',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined
})