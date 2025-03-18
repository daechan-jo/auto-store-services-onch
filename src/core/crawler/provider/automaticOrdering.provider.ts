import { CronType } from '@daechanjo/models';
import { Injectable } from '@nestjs/common';
import { Page } from 'playwright';

@Injectable()
export class AutomaticOrderingProvider {
  /**
   * 온채널 사이트에서 상품 코드로 상품을 검색하고 발주 페이지로 이동하는 메서드
   *
   * @param page - 작업을 수행할 Playwright 페이지 객체
   * @param query - 검색할 상품 코드
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 검색 및 발주 페이지 이동이 완료되면 해결되는 Promise
   *
   * @throws {Error} - 상품 검색 후 주문 버튼을 찾을 수 없는 경우 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 검색 입력란에 상품 코드 입력 (권장되는 page.fill() 메서드 사용)
   * 2. 엔터 키를 눌러 검색 실행
   * 3. 검색 결과가 로드될 때까지 대기
   * 4. 주문 버튼을 찾아 클릭하여 발주 페이지로 이동
   * 5. 발주 페이지가 완전히 로드될 때까지 대기
   *
   * 검색 결과에서 주문 버튼을 찾을 수 없는 경우 오류를 발생시킵니다.
   */
  async searchProduct(page: Page, query: string, cronId: string, type: string): Promise<void> {
    console.log(`${type}${cronId}: 상품 검색 시작`);

    // page.type() 대신 권장되는 page.fill() 사용
    await page.fill('#prd_sear_txt', query);

    // Promise.all로 네비게이션과 액션 동시 대기
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.keyboard.press('Enter'),
    ]);

    // 주문 버튼 존재 확인
    const orderButtonSelector = '.btn_order';

    try {
      // 주문 버튼이 나타날 때까지 명시적으로 대기 (타임아웃 추가)
      await page.waitForSelector(orderButtonSelector, { timeout: 5000 });
    } catch (error) {
      throw new Error(
        `${CronType.ERROR}${CronType.ORDER}${cronId}: 제품 코드에 대한 주문 버튼을 찾을 수 없습니다: ${query}\n${error}`,
      );
    }

    // 주문 버튼 클릭 후 페이지 로드 대기
    await Promise.all([page.waitForLoadState('networkidle'), page.click(orderButtonSelector)]);

    console.log(`${type}${cronId}: 발주 페이지 진입`);
  }

  /**
   * 온채널 발주 페이지에서 주문할 상품의 옵션을 선택하는 메서드
   *
   * @param page - 작업을 수행할 Playwright 페이지 객체
   * @param option - 선택할 옵션명 (쿠팡의 sellerProductItemName)
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 옵션 선택이 완료되면 해결되는 Promise
   *
   * @throws {Error} - 옵션 드롭다운에서 일치하는 옵션을 찾을 수 없는 경우 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 페이지에서 옵션 드롭다운(.selectOptionList) 요소를 찾아 모든 옵션을 추출
   * 2. 추출한 모든 옵션을 콘솔에 출력하여 디버깅 용이성 제공
   * 3. 공백을 제거한 정규화된 텍스트 비교를 통해 지정된 옵션과 일치하는 항목 검색
   *    (정확히 일치하거나 옵션 텍스트에 지정된 옵션이 포함된 경우 선택)
   * 4. 일치하는 옵션을 찾으면 해당 옵션의 value를 설정하고 change 이벤트 발생
   * 5. 일치하는 옵션을 찾지 못하면 상세한 오류 메시지와 함께 예외 발생
   *
   * 옵션 텍스트 비교 시 공백 차이로 인한 불일치를 방지하기 위해
   * normalizeText 함수를 사용하여 모든 공백을 제거합니다.
   */
  async selectProductOption(
    page: Page,
    option: string,
    cronId: string,
    type: string,
  ): Promise<void> {
    console.log(`${type}${cronId}: 옵션 설정 시작`);

    // 모든 옵션 텍스트를 추출하여 반환
    const allOptions = await page.evaluate(() => {
      const select = document.querySelector('.selectOptionList') as HTMLSelectElement;
      if (!select) return [];

      return Array.from(select.options).map((opt) => ({
        text: opt.textContent?.trim() || '',
        value: opt.value,
      }));
    });

    // Node.js 환경에서 옵션 리스트 출력
    console.log('사용 가능한 모든 옵션:');
    allOptions.forEach((opt, index) => {
      console.log(`${index}: "${opt.text}" (value: ${opt.value})`);
    });

    const normalizeText = (text: string) => text.replace(/\s+/g, '');

    // 옵션 찾기
    const targetOption = allOptions.find(
      (opt) =>
        normalizeText(opt.text) === normalizeText(option) ||
        normalizeText(opt.text).includes(normalizeText(option)),
    );

    if (!targetOption) {
      const errorMsg = `${CronType.ERROR}${type}${cronId}: 옵션을 찾을 수 없습니다 "${normalizeText(option)}"`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // 찾은 옵션 선택
    await page.evaluate((optionValue) => {
      const select = document.querySelector('.selectOptionList') as HTMLSelectElement;
      if (!select) throw new Error('옵션 리스트를 찾을 수 없습니다.');

      select.value = optionValue;
      select.dispatchEvent(new Event('change'));
    }, targetOption.value);

    console.log(`${type}${cronId}: "${targetOption.text}" 옵션 설정 완료`);
  }

  /**
   * 상품 수량을 설정하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param quantity - 설정할 상품 수량
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 수량 설정 작업이 완료되면 resolve되는 Promise
   *
   * @throws {Error} - 수량 설정 과정에서 발생하는 오류 (요소를 찾을 수 없거나 수량이 유효하지 않은 경우)
   *
   * @description
   * 이 메서드는 온채널 관리자 페이지에서 상품 발주 시 수량을 설정하는 기능을 담당합니다.
   * 1. 수량 입력 필드를 찾아 대기
   * 2. 기존 값을 모두 선택(triple-click)하여 지움
   * 3. 새로운 수량 값을 입력
   * 4. 입력이 안정적으로 처리되도록 짧은 대기 시간 추가
   */
  async setProductQuantity(
    page: Page,
    quantity: number,
    cronId: string,
    type: string,
  ): Promise<void> {
    if (!quantity)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 발주 개수를 찾을 수 없습니다.`);

    const optionQuantitySelector = '.optionQuantity';

    try {
      const quantityField = await page.waitForSelector(optionQuantitySelector, {
        state: 'visible',
        timeout: 5000,
      });

      await quantityField.click({ clickCount: 3 });

      // 새 수량 값 입력
      await quantityField.fill(quantity.toString());

      await page.waitForTimeout(200);
    } catch (error: any) {
      if (error instanceof Error) {
        throw new Error(`${CronType.ERROR}${type}${cronId}: 수량 설정 실패 - ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 온채널 발주 페이지에서 주문 상세 정보를 입력하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param order - 쿠팡에서 받은 주문 정보 객체
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<void>} - 주문 상세 정보 입력이 완료되면 resolve되는 Promise
   *
   * @throws {Error} - 주문 정보가 불완전하거나 입력 과정에서 오류가 발생하는 경우
   *
   * @description
   * 이 메서드는 온채널 발주 페이지에서 다음 주문 정보를 입력합니다:
   * 1. 수취인 이름
   * 2. 안심번호(연락처)
   * 3. 우편번호
   * 4. 배송지 주소
   * 5. 배송 메시지(있는 경우)
   *
   * 정보 입력 전 필수 필드(수취인 이름, 안심번호, 주소)가 존재하는지 검증합니다.
   */
  async fillOrderDetails(page: Page, order: any, cronId: string, type: string): Promise<void> {
    const receiver = order!.receiver;
    // 수취인 정보 유효성 검사
    if (!receiver.name || !receiver.safeNumber)
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 정보를 찾을 수 없습니다.`);

    // 주소 정보 유효성 검사
    const fullAddress = `${receiver.addr1 || ''} ${receiver.addr2 || ''}`.trim();
    if (!receiver.postCode || !fullAddress) {
      throw new Error(`${CronType.ERROR}${type}${cronId}: 수취인 주소를 찾을 수 없습니다.`);
    }

    const nameField = page.locator('input.orderName');
    const phoneField = page.locator('input.orderPhone');
    const postcodeField = page.locator('input.postcode');
    const addressField = page.locator('input.orderAddress');
    const commentField = page.locator('textarea.comment');

    // 병렬로 요소들이 로드될 때까지 대기
    await Promise.all([
      nameField.waitFor({ state: 'visible' }),
      phoneField.waitFor({ state: 'visible' }),
      postcodeField.waitFor({ state: 'visible' }),
      addressField.waitFor({ state: 'visible' }),
      commentField.waitFor({ state: 'visible' }),
    ]);

    // 각 필드에 데이터 입력
    // fill 메서드는 내부적으로 요소가 준비될 때까지 대기함
    await nameField.fill(receiver.name);
    await phoneField.fill(receiver.safeNumber);
    await postcodeField.fill(receiver.postCode);
    await addressField.fill(fullAddress);

    // 배송 메시지는 선택 사항이므로 null 또는 undefined 체크
    const parcelMessage = order.parcelPrintMessage || '';
    await commentField.fill(parcelMessage);
  }

  /**
   * 온채널에서 주문 완료 처리를 수행하는 메서드
   *
   * @param page - Playwright Page 객체
   * @param item - 현재 처리 중인 주문 항목 정보 (상품명, 발송 수량 등)
   * @param order - 주문의 상위 정보 (주문 ID 등)
   * @param cronId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param type - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<Object>} - 주문 처리 결과 객체를 반환하는 Promise
   *                             성공 시: {status: 'success', orderId, sellerProductName, shippingCount}
   *
   * @throws {Error} - 주문 완료 과정에서 발생하는 오류
   *
   * @description
   * 이 메서드는 온채널 발주 페이지에서 다음 작업을 수행합니다:
   * 1. 주문 완료 버튼을 클릭
   * 2. 확인 대화상자(dialog)를 자동으로 수락
   * 3. 페이지 이동 및 네트워크 요청 완료를 대기
   * 4. 성공적으로 처리된 주문의 결과 정보 반환
   */
  private async processOrder(
    page: Page,
    item: any,
    order: any,
    cronId: string,
    type: string,
  ): Promise<any> {
    const completeButton = page.locator('.btnOrderComplete');
    await completeButton.waitFor({ state: 'visible' });

    // 확인 대화상자가 표시될 때 자동으로 수락하도록 이벤트 리스너 설정
    // 이벤트 리스너는 단 한 번만 실행되도록 once 사용
    page.once('dialog', async (dialog) => {
      console.log(`${type}${cronId}: 확인 대화상자 "${dialog.message()}" 자동 수락`);
      await dialog.accept();
    });

    await completeButton.click();

    // Playwright의 개선된 대기 메커니즘 사용
    // waitForNavigation 대신 waitForLoadState 사용
    await page.waitForLoadState('networkidle', { timeout: 30000 });

    return {
      status: 'success',
      orderId: order.orderId,
      sellerProductName: item.sellerProductName,
      shippingCount: item.shippingCount,
    };
  }
}
