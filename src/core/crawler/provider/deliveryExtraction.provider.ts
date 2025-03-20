import { CronType, DeliveryData } from '@daechanjo/models';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

import { courierNames } from '../../../common/couries';

@Injectable()
export class DeliveryExtractionProvider {
  /**
   * 운송장 데이터 추출 (페이지네이션 처리 포함)
   */
  async extractDeliveryData(onchPage: Page, type: string, cronId: string): Promise<DeliveryData[]> {
    let onchResults: DeliveryData[] = [];
    let currentPage = 1;
    let hasNextPage = true;

    // 모든 페이지의 데이터를 수집할 때까지 반복
    while (hasNextPage) {
      // 현재 페이지 데이터 추출
      const pageData: DeliveryData[] = await this.extractCurrentPageData(onchPage);
      console.log(JSON.stringify(pageData, null, 2));

      // 유효한 데이터가 없으면 페이지 탐색 종료
      if (pageData.length === 0) {
        console.log(`${type}${cronId}: 더 이상 유효한 데이터가 없습니다. 루프를 종료합니다.`);

        break;
      }

      // 추출된 데이터를 결과 배열에 추가
      onchResults = onchResults.concat(pageData);

      // 다음 페이지로 이동 시도
      const movedToNextPage = await this.moveToNextPage(onchPage, currentPage, type, cronId);

      if (movedToNextPage) {
        currentPage++;
      } else {
        hasNextPage = false;
      }
    }
    console.log(JSON.stringify(onchResults, null, 2));
    return onchResults;
  }

  async extractCurrentPageData(onchPage: Page) {
    // 모든 제품 항목 가져오기
    const productItems = await onchPage.locator('.prd_list_li').all();
    const results: DeliveryData[] = [];

    // 각 제품 항목에 대해 처리
    for (const item of productItems) {
      // 날짜 요소 찾기
      const dateElement = item.locator('font[color="#135bc8"]').first();
      // 날짜 요소가 없으면 건너뛰기
      if (!(await dateElement.count())) continue;

      // 날짜 텍스트 가져오기
      const dateText = await dateElement.textContent();

      // 고객 이름 및 연락처 정보 추출
      const nameElement = item.locator('.prd_list_name div');
      // 이름 추출 (첫 번째 텍스트 노드)
      const nameText = await nameElement.evaluate((el) => {
        // 첫 번째 텍스트 노드 찾기 (BR 태그 이전의 텍스트)
        const textNodes = Array.from(el.childNodes).filter(
          (node) => node.nodeType === Node.TEXT_NODE,
        );
        return textNodes.length > 0 ? textNodes[0].textContent.trim() : '';
      });

      // 전화번호 추출 (font 태그 내 첫 번째 줄)
      const phoneElement = nameElement.locator('font[color="#555555"]');
      const phoneText = await phoneElement.evaluate((el) => {
        // 첫 번째 줄만 가져오기 (br 태그 이전)
        const content = el.innerHTML.split('<br>')[0];
        return content.trim();
      });
      console.log(JSON.stringify(nameText, null, 2));
      console.log(JSON.stringify(phoneText, null, 2));

      // 배송 상태 및 결제 방법 추출
      // const stateElement = item.locator('.prd_list_state div');
      // const stateText = (await stateElement.locator('b').textContent()) || '';
      // const paymentMethodElement = stateElement.locator('font[style*="color:#555555"]');
      // const paymentMethod = (await paymentMethodElement.textContent()) || '';

      // 택배사 정보 확인
      const trackBtn = item.locator('.trackBtn');
      const courierName = (await trackBtn.getAttribute('data-name')) || '';
      const trackNumber = (await trackBtn.getAttribute('data-num')) || '';

      const isSupportedCourier = courierNames.some((name) => courierName.includes(name));
      if (dateText && isSupportedCourier) {
        results.push({
          deliveryDate: dateText,
          nameText,
          phoneText,
          courier: courierName,
          trackNumber,
        });
      }
    }

    return results;
  }

  /**
   * 다음 페이지로 이동
   */
  private async moveToNextPage(
    onchPage: Page,
    currentPage: number,
    type: string,
    cronId: string,
  ): Promise<boolean> {
    // 다음 페이지 링크 확인
    const nextPageSelector = `.prd_list_bottom a[href*="page=${currentPage + 1}"]`;
    const nextPageLink = await onchPage.$(nextPageSelector);

    if (!nextPageLink) {
      console.log(`${type}${cronId}: 더 이상 페이지가 없습니다.`);
      return false;
    }

    console.log(`${type}${cronId}: 페이지 ${currentPage + 1}로 이동 중...`);

    // Playwright에서는 waitForNavigation과 click을 함께 사용하는 것이 권장됨
    try {
      // Promise.all을 사용하여 클릭과 페이지 로드를 동시에 대기
      await Promise.all([
        onchPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        nextPageLink.click(),
      ]);

      // 페이지 전환 후 잠시 대기하여 콘텐츠 로딩 보장
      await onchPage.waitForTimeout(500);
      return true;
    } catch (error: any) {
      console.error(
        `${CronType.ERROR}${type}${cronId}: 페이지 ${currentPage + 1}로 이동 실패`,
        error.response?.data || error.message,
      );
      return false;
    }
  }
}
