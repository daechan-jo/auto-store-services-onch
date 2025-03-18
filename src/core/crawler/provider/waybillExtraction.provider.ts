import { CronType, OnchSoldout } from '@daechanjo/models';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

import { courierNames } from '../../../common/couries';

@Injectable()
export class WaybillExtractionProvider {
  /**
   * 운송장 데이터 추출 (페이지네이션 처리 포함)
   */
  async extractWaybillData(
    onchPage: Page,
    lastCronTime: Date,
    type: string,
    cronId: string,
  ): Promise<OnchSoldout[]> {
    let onchResults: OnchSoldout[] = [];
    let currentPage = 1;
    let hasNextPage = true;

    // 모든 페이지의 데이터를 수집할 때까지 반복
    while (hasNextPage) {
      // 현재 페이지 데이터 추출
      const pageData = await this.extractCurrentPageData(onchPage, lastCronTime);

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

    return onchResults;
  }

  async extractCurrentPageData(onchPage: Page, lastCronTime: Date): Promise<OnchSoldout[]> {
    // TypeScript 타입 안전성을 위한 인터페이스 정의
    interface EvalArgs {
      lastCronTime: string;
      courierNames: string[];
    }

    // 현재 페이지의 제품 목록에서 데이터 추출
    return await onchPage.$$eval<OnchSoldout[], EvalArgs>(
      '.prd_list_li',
      (elements, args) => {
        const { lastCronTime, courierNames } = args;

        // 각 행에서 필요한 정보 추출 및 필터링
        return elements
          .map((row) => {
            // 날짜 정보 추출 및 검증
            const dateElement = row.querySelector('.prd_list_date font[color="#135bc8"]');
            if (!dateElement) return null;

            const dateText = dateElement.textContent.trim();
            // 날짜 형식 변환 (YYYY-MM-DD HH:MM:SS → ISO 형식)
            const formattedDateText = `${dateText.slice(0, 10)}T${dateText.slice(10)}`;
            const rowDate = new Date(formattedDateText);

            // 마지막 크론 실행 시간보다 이전 데이터는 제외
            if (rowDate <= new Date(lastCronTime)) return null;

            return this.extractRowData(row, courierNames);
          })
          .filter((item): item is OnchSoldout => item !== null); // null 항목 제거 및 타입 가드 적용
      },
      {
        lastCronTime: lastCronTime.toISOString(), // Date 객체를 ISO 문자열로 변환
        courierNames,
      },
    );
  }

  /**
   * 행(row)에서 데이터 추출하는 함수 (페이지 컨텍스트 내에서 실행)
   * 클라이언트 측 코드로 브라우저 내에서 실행됨
   */
  private extractRowData(row: Element, courierNames: string[]): OnchSoldout | null {
    // 고객 이름 및 연락처 정보 추출
    const nameElement = row.querySelector('.prd_list_name div');
    const name = nameElement?.childNodes[0]?.textContent.trim() || '';
    const phone = nameElement?.querySelector('font')?.textContent.trim() || '';

    // 배송 상태 및 결제 방법 정보 추출
    const stateElement = row.querySelector('.prd_list_state div');
    const state = stateElement?.querySelector('b')?.textContent.trim() || '';
    const paymentMethod =
      stateElement?.querySelector('font[style*="color:#555555"]')?.textContent.trim() || '';

    // 택배사 정보 추출 (courierNames 배열의 택배사 이름과 일치하는지 검사)
    const courierRegex = new RegExp(`(${courierNames.join('|')})`, 'i'); // 대소문자 무시 옵션 추가
    const stateText = stateElement?.textContent || '';
    const courierMatch = stateText.match(courierRegex);
    const courier = courierMatch ? courierMatch[1] : '';

    // 송장번호 추출
    const trackingNumber =
      stateElement?.querySelector('font[style*="font-size: 15px"]')?.textContent.trim() || '';

    // 추출된 정보를 객체로 반환
    return {
      name,
      phone,
      state,
      paymentMethod,
      courier,
      trackingNumber,
    };
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
