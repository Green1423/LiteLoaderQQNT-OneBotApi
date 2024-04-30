import { ActionName } from '../types'
import BaseAction from '../BaseAction'
import { dbUtil } from '../../../common/db'
import { NTQQMsgApi } from '../../../ntqqapi/api/msg'

interface Payload {
  message_id: number
}

class DeleteMsg extends BaseAction<Payload, void> {
  actionName = ActionName.DeleteMsg

  protected async _handle(payload: Payload) {
    let msg = await dbUtil.getMsgByShortId(payload.message_id)
    if (!msg) {
      throw `消息${payload.message_id}不存在`
    }
    await NTQQMsgApi.recallMsg(
      {
        chatType: msg.chatType,
        peerUid: msg.peerUid,
      },
      [msg.msgId],
    )
  }
}

export default DeleteMsg
