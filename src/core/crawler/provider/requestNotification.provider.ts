import { Page } from 'playwright';
import { PlaywrightService } from '@daechanjo/playwright';

export class RequestNotificationProvider {
  constructor(private readonly playwrightService: PlaywrightService) {}

  /**
   * 온채 페이지에서 새로운 알림을 확인하는 메서드
   *
   * 주어진 Playwright Page 객체를 사용하여 온채 관리자 페이지에서
   * 두 가지 유형의 알림을 확인합니다:
   * 1. 공급사 알림 (특정 선택자를 통해 확인)
   * 2. 반품/교환 알림 (new_btn.gif 이미지를 검색)
   *
   * 두 알림 중 하나라도 존재하면 true를 반환합니다.
   *
   * @param onchPage - 이미 로그인된 온채 사이트의 Playwright Page 객체
   * @returns 알림이 존재하면 true, 그렇지 않으면 false
   * @throws 페이지 액세스나 요소 선택 중 오류가 발생할 수 있으나 내부적으로 처리됨
   */
  async requestNotification(onchPage: Page): Promise<boolean> {
    try {
      // 공급사 알림
      const notificationSelector =
        'body > center > table > tbody > tr:nth-child(2) > td:nth-child(1) > table > tbody > tr > td > table > tbody > tr:nth-child(3) > td > a > img:nth-child(2)';
      const notificationElement = await onchPage.$(notificationSelector);

      // 반품교환 알림
      const returnNotificationElements = await onchPage.$$(
        'img[src="./images/new_btn.gif"][style="vertical-align:middle;"]',
      );

      // 요소가 존재하면 true, 없으면 false 반환
      return notificationElement !== null || returnNotificationElements.length > 0;
    } catch (error) {
      console.error('알림 확인 중 오류 발생:', error);
      return false; // 오류 발생 시 알림 없는 것으로 처리
    }
  }
}
