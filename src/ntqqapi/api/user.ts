import { invoke, NTMethod } from '../ntcall'
import { GeneralCallResult } from '../services'
import { User, UserDetailInfoByUin, UserDetailInfoByUinV2, UserDetailInfoListenerArg } from '../types'
import { getBuildVersion } from '@/common/utils'
import { getSession } from '@/ntqqapi/wrapper'
import { RequestUtil } from '@/common/utils/request'
import { NodeIKernelProfileService, UserDetailSource, ProfileBizType, forceFetchClientKeyRetType } from '../services'
import { NodeIKernelProfileListener } from '../listeners'
import { NTEventDispatch } from '@/common/utils/eventTask'
import { Time } from 'cosmokit'
import { Service, Context } from 'cordis'
import { selfInfo } from '@/common/globalVars'

declare module 'cordis' {
  interface Context {
    ntUserApi: NTQQUserApi
  }
}

export class NTQQUserApi extends Service {
  constructor(protected ctx: Context) {
    super(ctx, 'ntUserApi', true)
  }

  async setQQAvatar(filePath: string) {
    return await invoke<GeneralCallResult>({
      methodName: NTMethod.SET_QQ_AVATAR,
      args: [
        {
          path: filePath,
        },
        null,
      ],
      timeout: 10 * Time.second, // 10秒不一定够
    })
  }

  async fetchUserDetailInfo(uid: string) {
    let info: UserDetailInfoListenerArg
    if (NTEventDispatch.initialised) {
      type EventService = NodeIKernelProfileService['fetchUserDetailInfo']
      type EventListener = NodeIKernelProfileListener['onUserDetailInfoChanged']
      const [_retData, profile] = await NTEventDispatch.CallNormalEvent
        <EventService, EventListener>
        (
          'NodeIKernelProfileService/fetchUserDetailInfo',
          'NodeIKernelProfileListener/onUserDetailInfoChanged',
          1,
          5000,
          (profile) => profile.uid === uid,
          'BuddyProfileStore',
          [uid],
          UserDetailSource.KSERVER,
          [ProfileBizType.KALL]
        )
      info = profile
    } else {
      const result = await invoke<{ info: UserDetailInfoListenerArg }>({
        methodName: 'nodeIKernelProfileService/fetchUserDetailInfo',
        cbCmd: 'nodeIKernelProfileListener/onUserDetailInfoChanged',
        afterFirstCmd: false,
        cmdCB: payload => payload.info.uid === uid,
        args: [
          {
            callFrom: 'BuddyProfileStore',
            uid: [uid],
            source: UserDetailSource.KSERVER,
            bizList: [ProfileBizType.KALL]
          },
          null
        ],
      })
      info = result.info
    }
    const ret: User = {
      ...info.simpleInfo.coreInfo,
      ...info.simpleInfo.status,
      ...info.simpleInfo.vasInfo,
      ...info.commonExt,
      ...info.simpleInfo.baseInfo,
      qqLevel: info.commonExt?.qqLevel,
      pendantId: ''
    }
    return ret
  }

  async getUserDetailInfo(uid: string, getLevel = false, withBizInfo = true) {
    if (getBuildVersion() >= 26702) {
      return this.fetchUserDetailInfo(uid)
    }
    if (NTEventDispatch.initialised) {
      type EventService = NodeIKernelProfileService['getUserDetailInfoWithBizInfo']
      type EventListener = NodeIKernelProfileListener['onProfileDetailInfoChanged']
      const [_retData, profile] = await NTEventDispatch.CallNormalEvent
        <EventService, EventListener>
        (
          'NodeIKernelProfileService/getUserDetailInfoWithBizInfo',
          'NodeIKernelProfileListener/onProfileDetailInfoChanged',
          2,
          5000,
          (profile) => profile.uid === uid,
          uid,
          [0]
        )
      return profile
    } else {
      const result = await invoke<{ info: User }>({
        methodName: 'nodeIKernelProfileService/getUserDetailInfoWithBizInfo',
        cbCmd: 'nodeIKernelProfileListener/onProfileDetailInfoChanged',
        afterFirstCmd: false,
        cmdCB: (payload) => payload.info.uid === uid,
        args: [
          {
            uid,
            bizList: [0]
          },
          null,
        ],
      })
      return result.info
    }
  }

  async getSkey(): Promise<string> {
    const clientKeyData = await this.forceFetchClientKey()
    if (clientKeyData?.result !== 0) {
      throw new Error('获取clientKey失败')
    }
    const url = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' + selfInfo.uin
      + '&clientkey=' + clientKeyData.clientKey
      + '&u1=https%3A%2F%2Fh5.qzone.qq.com%2Fqqnt%2Fqzoneinpcqq%2Ffriend%3Frefresh%3D0%26clientuin%3D0%26darkMode%3D0&keyindex=' + clientKeyData.keyIndex
    return (await RequestUtil.HttpsGetCookies(url))?.skey
  }

  async getCookies(domain: string) {
    const clientKeyData = await this.forceFetchClientKey()
    if (clientKeyData?.result !== 0) {
      throw new Error('获取clientKey失败')
    }
    const uin = selfInfo.uin
    const requestUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' + uin + '&clientkey=' + clientKeyData.clientKey + '&u1=https%3A%2F%2F' + domain + '%2F' + uin + '%2Finfocenter&keyindex=19%27'
    const cookies: { [key: string]: string; } = await RequestUtil.HttpsGetCookies(requestUrl)
    return cookies
  }

  genBkn(sKey: string) {
    sKey = sKey || ''
    let hash = 5381

    for (let i = 0; i < sKey.length; i++) {
      const code = sKey.charCodeAt(i)
      hash = hash + (hash << 5) + code
    }

    return (hash & 0x7fffffff).toString()
  }

  async like(uid: string, count = 1) {
    const session = getSession()
    if (session) {
      return session.getProfileLikeService().setBuddyProfileLike({
        friendUid: uid,
        sourceId: 71,
        doLikeCount: count,
        doLikeTollCount: 0
      })
    } else {
      return await invoke<GeneralCallResult & { succCounts: number }>({
        methodName: 'nodeIKernelProfileLikeService/setBuddyProfileLike',
        args: [
          {
            doLikeUserInfo: {
              friendUid: uid,
              sourceId: 71,
              doLikeCount: count,
              doLikeTollCount: 0
            }
          },
          null,
        ],
      })
    }
  }

  async getUidByUinV1(Uin: string) {
    const session = getSession()
    // 通用转换开始尝试
    let uid = (await session?.getUixConvertService().getUid([Uin]))?.uidInfo.get(Uin)
    if (!uid) {
      let unveifyUid = (await this.getUserDetailInfoByUin(Uin)).info.uid;//从QQ Native 特殊转换 方法三
      if (unveifyUid.indexOf('*') == -1) {
        uid = unveifyUid
      }
    }
    return uid
  }

  async getUidByUinV2(uin: string) {
    const session = getSession()
    if (session) {
      let uid = (await session.getGroupService().getUidByUins([uin])).uids.get(uin)
      if (uid) return uid
      uid = (await session.getProfileService().getUidByUin('FriendsServiceImpl', [uin])).get(uin)
      if (uid) return uid
      uid = (await session.getUixConvertService().getUid([uin])).uidInfo.get(uin)
      if (uid) return uid
    } else {
      let uid = (await invoke<{ uids: Map<string, string> }>({
        methodName: 'nodeIKernelGroupService/getUidByUins',
        args: [
          { uin: [uin] },
          null,
        ],
      })).uids.get(uin)
      if (uid) return uid
      uid = (await invoke<Map<string, string>>({
        methodName: 'nodeIKernelProfileService/getUidByUin',
        args: [
          {
            callFrom: 'FriendsServiceImpl',
            uin: [uin],
          },
          null,
        ],
      })).get(uin)
      if (uid) return uid
      uid = (await invoke<{ uidInfo: Map<string, string> }>({
        methodName: 'nodeIKernelUixConvertService/getUid',
        args: [
          { uin: [uin] },
          null,
        ],
      })).uidInfo.get(uin)
      if (uid) return uid
    }
    const unveifyUid = (await this.getUserDetailInfoByUinV2(uin)).detail.uid //从QQ Native 特殊转换
    if (unveifyUid.indexOf('*') == -1) return unveifyUid
  }

  async getUidByUin(Uin: string) {
    if (getBuildVersion() >= 26702) {
      return await this.getUidByUinV2(Uin)
    }
    return await this.getUidByUinV1(Uin)
  }

  async getUserDetailInfoByUinV2(uin: string) {
    if (NTEventDispatch.initialised) {
      return await NTEventDispatch.CallNoListenerEvent
        <(Uin: string) => Promise<UserDetailInfoByUinV2>>(
          'NodeIKernelProfileService/getUserDetailInfoByUin',
          5000,
          uin
        )
    } else {
      return await invoke<UserDetailInfoByUinV2>({
        methodName: 'nodeIKernelProfileService/getUserDetailInfoByUin',
        args: [
          { uin },
          null,
        ],
      })
    }
  }

  async getUserDetailInfoByUin(Uin: string) {
    return NTEventDispatch.CallNoListenerEvent
      <(Uin: string) => Promise<UserDetailInfoByUin>>(
        'NodeIKernelProfileService/getUserDetailInfoByUin',
        5000,
        Uin
      )
  }

  async getUinByUidV1(Uid: string) {
    const ret = await NTEventDispatch.CallNoListenerEvent
      <(Uin: string[]) => Promise<{ uinInfo: Map<string, string> }>>(
        'NodeIKernelUixConvertService/getUin',
        5000,
        [Uid]
      )
    let uin = ret.uinInfo.get(Uid)
    if (!uin) {
      uin = (await this.getUserDetailInfo(Uid)).uin //从QQ Native 转换
    }
    return uin
  }

  async getUinByUidV2(uid: string) {
    const session = getSession()
    if (session) {
      let uin = (await session.getGroupService().getUinByUids([uid])).uins.get(uid)
      if (uin) return uin
      uin = (await session.getProfileService().getUinByUid('FriendsServiceImpl', [uid])).get(uid)
      if (uin) return uin
      uin = (await session.getUixConvertService().getUin([uid])).uinInfo.get(uid)
      if (uin) return uin
      return uin
    } else {
      let uin = (await invoke<{ uins: Map<string, string> }>({
        methodName: 'nodeIKernelGroupService/getUinByUids',
        args: [
          { uid: [uid] },
          null,
        ],
      })).uins.get(uid)
      if (uin) return uin
      uin = (await invoke<Map<string, string>>({
        methodName: 'nodeIKernelProfileService/getUinByUid',
        args: [
          {
            callFrom: 'FriendsServiceImpl',
            uid: [uid],
          },
          null,
        ],
      })).get(uid)
      if (uin) return uin
      uin = (await invoke<{ uinInfo: Map<string, string> }>({
        methodName: 'nodeIKernelUixConvertService/getUin',
        args: [
          { uid: [uid] },
          null,
        ],
      })).uinInfo.get(uid)
      if (uin) return uin
    }
    let uin = (await this.ctx.ntFriendApi.getBuddyIdMap(true)).getKey(uid)
    if (uin) return uin
    uin = (await this.getUserDetailInfo(uid)).uin //从QQ Native 转换
  }

  async getUinByUid(Uid: string) {
    if (getBuildVersion() >= 26702) {
      return (await this.getUinByUidV2(Uid))!
    }
    return await this.getUinByUidV1(Uid)
  }

  async forceFetchClientKey() {
    const session = getSession()
    if (session) {
      return await session.getTicketService().forceFetchClientKey('')
    } else {
      return await invoke<forceFetchClientKeyRetType>({
        methodName: 'nodeIKernelTicketService/forceFetchClientKey',
        args: [{
          domain: ''
        }, null],
      })
    }
  }

  async getSelfNick(refresh = false) {
    if ((refresh || !selfInfo.nick) && selfInfo.uid) {
      const userInfo = await this.getUserDetailInfo(selfInfo.uid)
      if (userInfo) {
        Object.assign(selfInfo, { nick: userInfo.nick })
        return userInfo.nick
      }
    }
    return selfInfo.nick
  }
}
