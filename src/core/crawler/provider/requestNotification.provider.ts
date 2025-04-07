import { Page } from 'playwright';
import { PlaywrightService } from '@daechanjo/playwright';

export class RequestNotificationProvider {
  constructor(private readonly playwrightService: PlaywrightService) {}

  /**
   * onch 페이지에서 새로운 알림이 있는지 확인합니다.
   * @param onchPage - 온치 페이지 객체
   * @returns 새로운 알림이 있으면 true, 없으면 false를 반환합니다.
   */
  async requestNotification(onchPage: Page): Promise<boolean> {
    try {
      // CSS 선택자를 사용하여 알림 이미지 요소가 존재하는지 확인
      const notificationSelector =
        'body > center > table > tbody > tr:nth-child(2) > td:nth-child(1) > table > tbody > tr > td > table > tbody > tr:nth-child(3) > td > a > img:nth-child(2)';

      // 요소가 존재하는지 확인 (waitForSelector 대신 selector를 사용하여 존재 여부만 체크)
      const notificationElement = await onchPage.$(notificationSelector);

      // 요소가 존재하면 true, 없으면 false 반환
      return notificationElement !== null;
    } catch (error) {
      console.error('알림 확인 중 오류 발생:', error);
      return false; // 오류 발생 시 알림 없는 것으로 처리
    }
  }
}
