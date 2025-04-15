import {
  AdulTypeEncoding,
  ChannelTypeEncoding,
  ProductRegistrationReqDto,
  ProductRegistrationResult,
  TaxTypeEncoding,
} from '@daechanjo/models';
import { RabbitMQService } from '@daechanjo/rabbitmq';
import { Page } from 'playwright';

export class ProductRegistrationProvider {
  private readonly MAX_RETRY_COUNT = 3;
  constructor(private readonly rabbitmqService: RabbitMQService) {}

  /**
   * 온채 상품 검색 URL을 생성하는 메서드
   *
   * 상품 등록 요청 데이터를 기반으로 온채 상품 검색 페이지 URL을 생성합니다.
   * 모든 매개변수에 대해 적절한 인코딩 처리를 수행합니다.
   *
   * @param data - 상품 등록 요청 데이터 (키워드, 카테고리, 세금 유형, 성인 유형, 채널 등)
   * @returns {string} - 완성된 온채 상품 검색 URL
   */
  createOnchProductSearchUrl(data: ProductRegistrationReqDto): string {
    const tax = TaxTypeEncoding[data.tax];
    const adult = AdulTypeEncoding[data.adult];
    const channel = ChannelTypeEncoding[data.channel];

    const encodedKeyword = encodeURIComponent(data.keyword);
    const encodedCategory = encodeURIComponent(data.category || '');
    const encodedTax = encodeURIComponent(tax || '');
    const encodedAdult = encodeURIComponent(adult || '');
    const encodedChannel = encodeURIComponent(channel || '');
    const encodedLimit = encodeURIComponent(data.limit || '');

    return `https://www.onch3.co.kr/dbcenter_renewal/index.php?keyword=${encodedKeyword}&cate_f=${encodedCategory}&cate_s=&cate_t=&cate_fr=&sprice=${data.minPrice || ''}&eprice=${data.maxPrice || ''}&tax_type=${encodedTax}&is_adult=${encodedAdult}&search_channel=${encodedChannel}&provider_grade_cls=&provider_sgrade=&agree_sdt=&agree_edt=&send_sprice=&send_eprice=&detail_keyword=&pgn=${encodedLimit}`;
  }

  /**
   * 여러 페이지에 걸쳐 상품 등록 작업을 처리하는 메서드
   *
   * 지정된 반복 횟수만큼 페이지를 순회하며 각 페이지에서 상품 등록 작업을 수행합니다.
   * 일일 요청 제한에 도달하거나 더 이상 상품이 없는 경우 자동으로 중단합니다.
   *
   * @param page - Playwright Page 객체
   * @param baseUrl - 기본 URL
   * @param repeatCount - 반복 횟수 (페이지 수)
   * @param jobId - 작업 식별자
   * @param jobType - 작업 유형
   * @returns {ProductRegistrationResult[]} - 상품 등록 결과 배열
   */
  async processPages(
    page: Page,
    baseUrl: string,
    repeatCount: number,
    jobId: string,
    jobType: string,
  ): Promise<ProductRegistrationResult[]> {
    const results: ProductRegistrationResult[] = [];
    let dailyLimitReached = false;

    // 페이지 별 처리
    for (let currentPage = 1; currentPage <= repeatCount; currentPage++) {
      // 일일 요청 제한에 걸렸으면 더 이상 처리하지 않음
      if (dailyLimitReached) {
        console.log(`${jobType}${jobId}: 일일 요청 제한으로 인해 남은 페이지 처리 중단`);
        break;
      }

      const pageUrl = currentPage === 1 ? baseUrl : `${baseUrl}&page=${currentPage}`;
      console.log(`${jobType}${jobId}: ${currentPage}/${repeatCount} 페이지 처리 시작`);

      const pageResult = await this.processPage(
        page,
        pageUrl,
        currentPage,
        repeatCount,
        jobId,
        jobType,
      );

      if (pageResult.dailyLimitReached) {
        dailyLimitReached = true;
      }

      if (pageResult.result) {
        results.push(pageResult.result);
      }

      if (pageResult.noMoreProducts) {
        break;
      }
    }

    console.log(`${jobType}${jobId}: 모든 페이지 처리 완료.`);

    return results;
  }

  /**
   * 단일 페이지에서 상품 등록 작업을 처리하는 메서드
   *
   * 페이지 로드, 상품 등록 액션 실행, 결과 처리 등을 담당합니다.
   * 오류 발생 시 최대 재시도 횟수만큼 재시도합니다.
   *
   * @param page - Playwright Page 객체
   * @param pageUrl - 처리할 페이지 URL
   * @param currentPage - 현재 페이지 번호
   * @param repeatCount - 전체 반복 횟수
   * @param jobId - 작업 식별자
   * @param jobType - 작업 유형
   * @returns {Promise<{
   *     result?: ProductRegistrationResult;
   *     dailyLimitReached: boolean;
   *     noMoreProducts: boolean;
   *   }>} - 페이지 처리 결과 (등록 결과, 일일 제한 도달 여부, 상품 존재 여부)
   * @private
   */
  private async processPage(
    page: Page,
    pageUrl: string,
    currentPage: number,
    repeatCount: number,
    jobId: string,
    jobType: string,
  ): Promise<{
    result?: ProductRegistrationResult;
    dailyLimitReached: boolean;
    noMoreProducts: boolean;
  }> {
    let retryCount = 0;
    let dailyLimitReached = false;
    let noMoreProducts = false;

    while (retryCount < this.MAX_RETRY_COUNT) {
      try {
        // 페이지로 이동
        await page.goto(pageUrl);
        await page.waitForLoadState('networkidle');

        // 페이지가 올바르게 로드되었는지 확인 (pagination 요소 확인)
        const paginationSelector = 'ul.pagination';
        await page
          .waitForSelector(paginationSelector, { timeout: 3000 })
          .catch(() =>
            console.log(`${jobType}${jobId}: 페이지네이션 요소를 찾을 수 없음, 계속 진행`),
          );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 상품 등록 액션 책임 분리
        const actionResult = await this.performProductRegistrationAction(page, jobId, jobType);

        // 일일 요청 제한에 걸린 경우
        if (actionResult.dailyLimitReached) {
          dailyLimitReached = true;
          return { dailyLimitReached, noMoreProducts };
        }

        // 더 이상 상품이 없는 경우
        if (actionResult.alertMessage.includes('상품을 선택해 주세요')) {
          console.log(`${jobType}${jobId}: 더 이상 상품이 없음. 반복 중단`);
          noMoreProducts = true;
          return { dailyLimitReached, noMoreProducts };
        }

        // 상품 등록 실패한 경우
        if (actionResult.alertMessage.includes('상품 전송에 실패하였습니다')) {
          console.log(`${jobType}${jobId}: 이 페이지의 모든 상품 등록 실패, 다음 페이지로 진행`);
          return {
            result: {
              page: currentPage,
              success: false,
              alertMessage: actionResult.alertMessage,
              errorMessage: '',
            },
            dailyLimitReached,
            noMoreProducts,
          };
        }

        // 성공한 경우
        return {
          result: {
            page: currentPage,
            success: true,
            alertMessage: actionResult.alertMessage,
            errorMessage: '',
          },
          dailyLimitReached,
          noMoreProducts,
        };
      } catch (error: any) {
        retryCount++;
        console.warn(
          `${jobType}${jobId}: ${currentPage}/${repeatCount} 페이지 - 오류 발생, 재시도 (${retryCount}/${this.MAX_RETRY_COUNT}): ${error.message}`,
        );

        if (retryCount >= this.MAX_RETRY_COUNT) {
          return {
            result: {
              page: currentPage,
              success: false,
              alertMessage: '',
              errorMessage: error.message,
            },
            dailyLimitReached,
            noMoreProducts,
          };
        }

        await new Promise((resolve) => setTimeout(resolve, 2000)); // 재시도 전 대기
      }
    }

    return { dailyLimitReached, noMoreProducts };
  }

  /**
   * 단일 페이지에서 상품 등록 액션을 수행하는 메서드
   *
   * 전체 선택 체크박스 클릭, 쿠팡 보내기 버튼 클릭, 전송하기 버튼 클릭 등
   * 실제 상품 등록에 필요한 UI 액션을 수행합니다.
   * API 응답을 모니터링하여 일일 요청 제한 등의 결과를 파악합니다.
   *
   * @param page - Playwright Page 객체
   * @param jobId - 작업 식별자
   * @param jobType - 작업 유형
   * @returns {Promise<{
   *     alertMessage: string;
   *     dailyLimitReached: boolean;
   *   }>} - 상품 등록 액션 결과 (알림 메시지와 일일 제한 도달 여부)
   * @private
   */
  private async performProductRegistrationAction(
    page: Page,
    jobId: string,
    jobType: string,
  ): Promise<{
    alertMessage: string;
    dailyLimitReached: boolean;
  }> {
    // 전체선택 체크박스 클릭
    const checkAllSelector =
      'body > div.content_wrap > section > div > div.db_sub_menu.excel_download_section > div:nth-child(1) > div.btn_chk_all > label';
    await page.waitForSelector(checkAllSelector, { timeout: 3000 });
    await page.click(checkAllSelector);

    // 클릭 후 잠시 대기
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 쿠팡 보내기 버튼 클릭
    const coupangButtonSelector =
      'body > div.content_wrap > section > div > div.db_sub_menu.excel_download_section > div:nth-child(1) > div:nth-child(4)';
    await page.waitForSelector(coupangButtonSelector, { timeout: 1000 });
    await page.click(coupangButtonSelector);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // API 응답 캡처를 위한 네트워크 이벤트 설정
    let apiResponseCaptured = false;
    let apiResponseError = '';
    let dailyLimitReached = false;

    const responseHandler = async (response: any) => {
      if (response.url().includes('onch3.co.kr/coupang_api/addItem_test.php')) {
        try {
          const respText = await response.text();
          if (
            respText.includes('일일 요청 제한') ||
            respText.includes('등록할 수 있는 구매옵션 개수') ||
            respText.includes('내일 다시 요청해주세요')
          ) {
            console.log(`${jobType}${jobId}: API 제한 감지 - ${respText}`);
            apiResponseError = respText;
            apiResponseCaptured = true;
          }
        } catch (e) {
          console.error(`${jobType}${jobId}: 응답 파싱 실패`, e);
        }
      }
    };

    // 응답 리스너 추가
    page.on('response', responseHandler);

    // 전송하기 버튼 클릭
    const submitButtonSelector =
      'body > div.content_wrap > section > div > div.coupang_modi_layer > div.smart_title > div.api_order_wrap > div > button.coupang_modi_btn';

    await page.waitForSelector(submitButtonSelector, { timeout: 1000 });
    await page.click(submitButtonSelector);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 일일 제한 응답 체크를 위한 최대 대기 시간 (밀리초)
    const API_RESPONSE_WAIT_TIME = 5000;
    let startTime = Date.now();

    // 일일 제한 체크 루프
    while (Date.now() - startTime < API_RESPONSE_WAIT_TIME) {
      if (apiResponseCaptured) {
        console.log(`${jobType}${jobId}: 일일 요청 제한 감지됨`);
        await this.rabbitmqService.emit('mail-queue', 'sendNotification', {
          jobId,
          jobType,
          jobName: '일일 상품 등록 요청 제한 안내',
          data: {
            title: '쿠팡 상품 등록 불가',
            message: '일일 상품 등록 요청 제한에 도달했습니다. 내일 다시 시도하세요.',
          },
        });

        // 전체 반복문 종료 플래그 설정
        dailyLimitReached = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100)); // 100ms마다 체크
    }

    // 알럿 대화상자 처리
    let alertMessage = '';
    const dialogPromise = new Promise<string>((resolve) => {
      page.once('dialog', async (dialog) => {
        console.log(`${jobType}${jobId}: 대화상자 감지 - ${dialog.message()}`);
        alertMessage = dialog.message();
        await dialog.accept();
        resolve(alertMessage);
      });
    });

    // 타임아웃 설정
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error('알럿 대화상자 타임아웃')), 300000);
    });

    alertMessage = await Promise.race([dialogPromise, timeoutPromise]);

    // 응답 리스너 제거
    page.removeListener('response', responseHandler);

    console.log(`${jobType}${jobId}: 알럿 메시지 - ${alertMessage}`);

    return {
      alertMessage,
      dailyLimitReached,
    };
  }
}
