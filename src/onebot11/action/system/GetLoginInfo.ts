import BaseAction from '../BaseAction'
import { OB11User } from '../../types'
import { ActionName } from '../types'
import { selfInfo } from '@/common/globalVars'

class GetLoginInfo extends BaseAction<null, OB11User> {
  actionName = ActionName.GetLoginInfo

  protected async _handle(payload: null) {
    let nickname = selfInfo.nick
    try {
      nickname = await this.ctx.ntUserApi.getSelfNick(true)
    } catch { }
    return {
      user_id: parseInt(selfInfo.uin),
      nickname
    }
  }
}

export default GetLoginInfo
