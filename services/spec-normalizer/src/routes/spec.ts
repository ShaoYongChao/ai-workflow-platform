import { Router } from 'express'
import { getSpec } from '../services/db'

export const specRouter = Router()

specRouter.get('/:id', async (req, res) => {
  const spec = await getSpec(req.params.id)
  if (!spec) return res.status(404).json({ error: 'Spec 不存在' })
  res.json(spec)
})