import { ActionName, BaseCheckResult } from './types'
import { OB11Response } from './OB11Response'
import { OB11Return } from '../types'
import { Context } from 'cordis'
import type Adapter from '../adapter'

abstract class BaseAction<PayloadType, ReturnDataType> {
  abstract actionName: ActionName
  protected ctx: Context

  constructor(protected adapter: Adapter) {
    this.ctx = adapter.ctx
  }

  protected async check(payload: PayloadType): Promise<BaseCheckResult> {
    return {
      valid: true,
    }
  }

  public async handle(payload: PayloadType): Promise<OB11Return<ReturnDataType | null>> {
    const result = await this.check(payload)
    if (!result.valid) {
      return OB11Response.error(result.message, 400)
    }
    try {
      const resData = await this._handle(payload)
      return OB11Response.ok(resData)
    } catch (e: any) {
      this.ctx.logger.error('发生错误', e)
      return OB11Response.error(e?.toString() || e?.stack?.toString() || '未知错误，可能操作超时', 200)
    }
  }

  public async websocketHandle(payload: PayloadType, echo: any): Promise<OB11Return<ReturnDataType | null>> {
    const result = await this.check(payload)
    if (!result.valid) {
      return OB11Response.error(result.message, 1400)
    }
    try {
      const resData = await this._handle(payload)
      return OB11Response.ok(resData, echo)
    } catch (e: any) {
      this.ctx.logger.error('发生错误', e)
      return OB11Response.error(e.stack?.toString() || e.toString(), 1200, echo)
    }
  }

  protected async _handle(payload: PayloadType): Promise<ReturnDataType> {
    throw `pleas override ${this.actionName} _handle`
  }
}

export default BaseAction
