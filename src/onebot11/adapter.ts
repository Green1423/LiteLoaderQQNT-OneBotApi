import { Service, Context } from 'cordis'
import { OB11Constructor } from './constructor'
import {
  GroupNotify,
  GroupNotifyTypes,
  RawMessage,
  BuddyReqType,
  Peer,
  FriendRequest,
  GroupMember,
  GroupMemberRole
} from '../ntqqapi/types'
import { OB11GroupRequestEvent } from './event/request/OB11GroupRequest'
import { OB11FriendRequestEvent } from './event/request/OB11FriendRequest'
import { MessageUnique } from '../common/utils/messageUnique'
import { GroupDecreaseSubType, OB11GroupDecreaseEvent } from './event/notice/OB11GroupDecreaseEvent'
import { selfInfo } from '../common/globalVars'
import { OB11Config, Config as LLOBConfig } from '../common/types'
import { OB11WebSocket, OB11WebSocketReverseManager } from './connect/ws'
import { OB11Http, OB11HttpPost } from './connect/http'
import { OB11BaseEvent } from './event/OB11BaseEvent'
import { OB11Message } from './types'
import { OB11BaseMetaEvent } from './event/meta/OB11BaseMetaEvent'
import { postHttpEvent } from './helper/eventForHttp'
import { initActionMap } from './action'
import { llonebotError } from '../common/globalVars'
import { OB11GroupCardEvent } from './event/notice/OB11GroupCardEvent'
import { OB11GroupAdminNoticeEvent } from './event/notice/OB11GroupAdminNoticeEvent'

declare module 'cordis' {
  interface Context {
    onebot: OneBot11Adapter
  }
}

class OneBot11Adapter extends Service {
  static inject = ['ntMsgApi', 'ntFileApi', 'ntFileCacheApi', 'ntFriendApi', 'ntGroupApi', 'ntUserApi', 'ntWindowApi']

  public messages: Map<string, RawMessage> = new Map()
  public startTime = 0
  private ob11WebSocket: OB11WebSocket
  private ob11WebSocketReverseManager: OB11WebSocketReverseManager
  private ob11Http: OB11Http
  private ob11HttpPost: OB11HttpPost

  constructor(public ctx: Context, public config: OneBot11Adapter.Config) {
    super(ctx, 'onebot', true)
    const actionMap = initActionMap(this)
    this.ob11Http = new OB11Http(ctx, {
      port: config.httpPort,
      token: config.token,
      actionMap
    })
    this.ob11HttpPost = new OB11HttpPost(ctx, {
      hosts: config.httpHosts,
      heartInterval: config.heartInterval,
      secret: config.httpSecret,
      enableHttpHeart: config.enableHttpHeart
    })
    this.ob11WebSocket = new OB11WebSocket(ctx, {
      port: config.wsPort,
      heartInterval: config.heartInterval,
      token: config.token,
      actionMap
    })
    this.ob11WebSocketReverseManager = new OB11WebSocketReverseManager(ctx, {
      hosts: config.wsHosts,
      heartInterval: config.heartInterval,
      token: config.token,
      actionMap
    })
  }

  /** 缓存近期消息内容 */
  public async addMsgCache(msg: RawMessage) {
    const expire = this.config.msgCacheExpire * 1000
    if (expire === 0) {
      return
    }
    const id = msg.msgId
    this.messages.set(id, msg)
    setTimeout(() => {
      this.messages.delete(id)
    }, expire)
  }

  /** 获取近期消息内容 */
  public getMsgCache(msgId: string) {
    return this.messages.get(msgId)
  }

  public dispatch(event: OB11BaseEvent | OB11Message) {
    if (this.config.enableWs) {
      this.ob11WebSocket.emitEvent(event)
    }
    if (this.config.enableWsReverse) {
      this.ob11WebSocketReverseManager.emitEvent(event)
    }
    if (this.config.enableHttpPost) {
      this.ob11HttpPost.emitEvent(event)
    }
    if ((event as OB11BaseMetaEvent).meta_event_type !== 'heartbeat') {
      // 不上报心跳
      postHttpEvent(event)
    }
  }

  private async handleGroupNotify(notifies: GroupNotify[]) {
    for (const notify of notifies) {
      try {
        notify.time = Date.now()
        const notifyTime = parseInt(notify.seq) / 1000
        const flag = notify.group.groupCode + '|' + notify.seq + '|' + notify.type
        if (notifyTime < this.startTime) {
          continue
        }
        if (notify.type == GroupNotifyTypes.MEMBER_EXIT || notify.type == GroupNotifyTypes.KICK_MEMBER) {
          this.ctx.logger.info('有成员退出通知', notify)
          const member1Uin = (await this.ctx.ntUserApi.getUinByUid(notify.user1.uid))!
          let operatorId = member1Uin
          let subType: GroupDecreaseSubType = 'leave'
          if (notify.user2.uid) {
            // 是被踢的
            const member2Uin = await this.ctx.ntUserApi.getUinByUid(notify.user2.uid)
            if (member2Uin) {
              operatorId = member2Uin
            }
            subType = 'kick'
          }
          const groupDecreaseEvent = new OB11GroupDecreaseEvent(
            parseInt(notify.group.groupCode),
            parseInt(member1Uin),
            parseInt(operatorId),
            subType,
          )
          this.dispatch(groupDecreaseEvent)
        }
        else if ([GroupNotifyTypes.JOIN_REQUEST, GroupNotifyTypes.JOIN_REQUEST_BY_INVITED].includes(notify.type)) {
          this.ctx.logger.info('有加群请求')
          let requestQQ = ''
          try {
            // uid-->uin
            requestQQ = (await this.ctx.ntUserApi.getUinByUid(notify.user1.uid))
            if (isNaN(parseInt(requestQQ))) {
              requestQQ = (await this.ctx.ntUserApi.getUserDetailInfo(notify.user1.uid)).uin
            }
          } catch (e) {
            this.ctx.logger.error('获取加群人QQ号失败 Uid:', notify.user1.uid, e)
          }
          let invitorId: string
          if (notify.type == GroupNotifyTypes.JOIN_REQUEST_BY_INVITED) {
            // groupRequestEvent.sub_type = 'invite'
            try {
              // uid-->uin
              invitorId = (await this.ctx.ntUserApi.getUinByUid(notify.user2.uid))
              if (isNaN(parseInt(invitorId))) {
                invitorId = (await this.ctx.ntUserApi.getUserDetailInfo(notify.user2.uid)).uin
              }
            } catch (e) {
              invitorId = ''
              this.ctx.logger.error('获取邀请人QQ号失败 Uid:', notify.user2.uid, e)
            }
          }
          const groupRequestEvent = new OB11GroupRequestEvent(
            parseInt(notify.group.groupCode),
            parseInt(requestQQ) || 0,
            flag,
            notify.postscript,
            invitorId! === undefined ? undefined : +invitorId,
            'add'
          )
          this.dispatch(groupRequestEvent)
        }
        else if (notify.type == GroupNotifyTypes.INVITE_ME) {
          this.ctx.logger.info('收到邀请我加群通知')
          const userId = (await this.ctx.ntUserApi.getUinByUid(notify.user2.uid)) || ''
          const groupInviteEvent = new OB11GroupRequestEvent(
            parseInt(notify.group.groupCode),
            parseInt(userId),
            flag,
            undefined,
            undefined,
            'invite'
          )
          this.dispatch(groupInviteEvent)
        }
      } catch (e: any) {
        this.ctx.logger.error('解析群通知失败', e.stack.toString())
      }
    }
  }

  private handleMsg(msgList: RawMessage[]) {
    for (let message of msgList) {
      // 过滤启动之前的消息
      if (parseInt(message.msgTime) < this.startTime / 1000) {
        continue
      }
      const peer: Peer = {
        chatType: message.chatType,
        peerUid: message.peerUid
      }
      message.msgShortId = MessageUnique.createMsg(peer, message.msgId)
      this.addMsgCache(message)

      OB11Constructor.message(this.ctx, message)
        .then((msg) => {
          if (!this.config.debug && msg.message.length === 0) {
            return
          }
          const isSelfMsg = msg.user_id.toString() === selfInfo.uin
          if (isSelfMsg && !this.config.reportSelfMessage) {
            return
          }
          if (isSelfMsg) {
            msg.target_id = parseInt(message.peerUin)
          }
          this.dispatch(msg)
        })
        .catch((e) => this.ctx.logger.error('constructMessage error: ', e.stack.toString()))

      OB11Constructor.GroupEvent(this.ctx, message).then((groupEvent) => {
        if (groupEvent) {
          this.dispatch(groupEvent)
        }
      })

      OB11Constructor.PrivateEvent(this.ctx, message).then((privateEvent) => {
        if (privateEvent) {
          this.dispatch(privateEvent)
        }
      })
    }
  }

  private handleRecallMsg(msgList: RawMessage[]) {
    for (const message of msgList) {
      if (message.recallTime != '0') {
        const oriMessageId = MessageUnique.getShortIdByMsgId(message.msgId)
        if (!oriMessageId) {
          continue
        }
        OB11Constructor.RecallEvent(this.ctx, message, oriMessageId).then((recallEvent) => {
          if (recallEvent) {
            this.dispatch(recallEvent)
          }
        })
      }
    }
  }

  private async handleFriendRequest(buddyReqs: FriendRequest[]) {
    for (const req of buddyReqs) {
      if (!!req.isInitiator || (req.isDecide && req.reqType !== BuddyReqType.KMEINITIATORWAITPEERCONFIRM)) {
        continue
      }
      if (+req.reqTime < this.startTime / 1000) {
        continue
      }
      let userId = 0
      try {
        const requesterUin = await this.ctx.ntUserApi.getUinByUid(req.friendUid)
        userId = parseInt(requesterUin)
      } catch (e) {
        this.ctx.logger.error('获取加好友者QQ号失败', e)
      }
      const flag = req.friendUid + '|' + req.reqTime
      const comment = req.extWords
      const friendRequestEvent = new OB11FriendRequestEvent(
        userId,
        comment,
        flag
      )
      this.dispatch(friendRequestEvent)
    }
  }

  private async handleConfigUpdated(config: LLOBConfig) {
    const old = this.config
    this.ob11Http.updateConfig({
      port: config.ob11.httpPort,
      token: config.token,
    })
    this.ob11HttpPost.updateConfig({
      hosts: config.ob11.httpHosts,
      heartInterval: config.heartInterval,
      secret: config.ob11.httpSecret,
      enableHttpHeart: config.ob11.enableHttpHeart
    })
    this.ob11WebSocket.updateConfig({
      port: config.ob11.wsPort,
      heartInterval: config.heartInterval,
      token: config.token,
    })
    this.ob11WebSocketReverseManager.updateConfig({
      hosts: config.ob11.wsHosts,
      heartInterval: config.heartInterval,
      token: config.token,
    })
    // 判断是否启用或关闭 HTTP 服务
    if (config.ob11.enableHttp !== old.enableHttp) {
      if (!config.ob11.enableHttp) {
        await this.ob11Http.stop()
      } else {
        this.ob11Http.start()
      }
    }
    // HTTP 端口变化，重启服务
    if (config.ob11.httpPort !== old.httpPort) {
      await this.ob11Http.stop()
      this.ob11Http.start()
    }
    // 判断是否启用或关闭正向 WebSocket
    if (config.ob11.enableWs !== old.enableWs) {
      if (config.ob11.enableWs) {
        this.ob11WebSocket.start()
      } else {
        await this.ob11WebSocket.stop()
      }
    }
    // 正向 WebSocket 端口变化，重启服务
    if (config.ob11.wsPort !== old.wsPort) {
      await this.ob11WebSocket.stop()
      this.ob11WebSocket.start()
      llonebotError.wsServerError = ''
    }
    // 判断是否启用或关闭反向ws
    if (config.ob11.enableWsReverse !== old.enableWsReverse) {
      if (config.ob11.enableWsReverse) {
        this.ob11WebSocketReverseManager.start()
      } else {
        this.ob11WebSocketReverseManager.stop()
      }
    }
    // 判断反向 WebSocket 地址有变化
    if (config.ob11.enableWsReverse) {
      if (config.ob11.wsHosts.length !== old.wsHosts.length) {
        this.ob11WebSocketReverseManager.stop()
        this.ob11WebSocketReverseManager.start()
      } else {
        for (const newHost of config.ob11.wsHosts) {
          if (!old.wsHosts.includes(newHost)) {
            this.ob11WebSocketReverseManager.stop()
            this.ob11WebSocketReverseManager.start()
            break
          }
        }
      }
    }
    if (config.ob11.enableHttpHeart !== old.enableHttpHeart) {
      this.ob11HttpPost.stop()
      this.ob11HttpPost.start()
    }
    Object.assign(this.config, {
      ...config.ob11,
      heartInterval: config.heartInterval,
      token: config.token!,
      debug: config.debug!,
      reportSelfMessage: config.reportSelfMessage!,
      msgCacheExpire: config.msgCacheExpire!,
    })
  }

  private async handleGroupMemberInfoUpdated(groupCode: string, members: GroupMember[]) {
    for (const member of members) {
      const existMember = await this.ctx.ntGroupApi.getGroupMember(groupCode, member.uin)
      if (existMember) {
        if (member.cardName != existMember.cardName) {
          this.ctx.logger.info('群成员名片变动', `${groupCode}: ${existMember.uin}`, existMember.cardName, '->', member.cardName)
          this.dispatch(
            new OB11GroupCardEvent(parseInt(groupCode), parseInt(member.uin), member.cardName, existMember.cardName),
          )
        } else if (member.role != existMember.role) {
          this.ctx.logger.info('有管理员变动通知')
          const groupAdminNoticeEvent = new OB11GroupAdminNoticeEvent(
            member.role == GroupMemberRole.admin ? 'set' : 'unset',
            parseInt(groupCode),
            parseInt(member.uin)
          )
          this.dispatch(groupAdminNoticeEvent)
        }
        Object.assign(existMember, member)
      }
    }
  }

  public start() {
    this.startTime = Date.now()
    if (this.config.enableWs) {
      this.ob11WebSocket.start()
    }
    if (this.config.enableWsReverse) {
      this.ob11WebSocketReverseManager.start()
    }
    if (this.config.enableHttp) {
      this.ob11Http.start()
    }
    if (this.config.enableHttpPost) {
      this.ob11HttpPost.start()
    }
    this.ctx.on('llonebot/config-updated', input => {
      this.handleConfigUpdated(input)
    })
    this.ctx.on('nt/message-created', input => {
      this.handleMsg(input)
    })
    this.ctx.on('nt/message-deleted', input => {
      this.handleRecallMsg(input)
    })
    this.ctx.on('nt/message-sent', input => {
      this.handleRecallMsg(input)
    })
    this.ctx.on('nt/group-notify', input => {
      this.handleGroupNotify(input)
    })
    this.ctx.on('nt/friend-request', input => {
      this.handleFriendRequest(input)
    })
    this.ctx.on('nt/group-member-info-updated', input => {
      this.handleGroupMemberInfoUpdated(input.groupCode, input.members)
    })
  }
}

namespace OneBot11Adapter {
  export interface Config extends OB11Config {
    heartInterval: number
    token: string
    debug: boolean
    reportSelfMessage: boolean
    msgCacheExpire: number
  }
}

export default OneBot11Adapter