const TimeLockedLptOrder = artifacts.require("TimeLockedLptOrder")
const ControllerMock = artifacts.require('ControllerMock')
const BondingManagerMock = artifacts.require('BondingManagerMock')
const RoundsManagerMock = artifacts.require('RoundsManagerMock')
const TestErc20 = artifacts.require('TestErc20')

const BN = require('bn.js')
const {assertEqualBN, assertRevert} = require('./helpers')
const {advanceBlock, latestBlock} = require('openzeppelin-test-helpers/src/time')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const advanceBlocks = async blocks => {
    for (var i = 0; i < blocks; i++) {
        await advanceBlock()
    }
}

const advanceToBlock = async block =>
    await advanceBlocks(block - await latestBlock())

contract('TimeLockedLptOrder', ([sellOrderCreator, sellOrderBuyer]) => {

    this.unbondingPeriodRounds = 7
    this.roundLengthBlocks = 2

    this.lptSellValue = 30
    this.daiPaymentValue = 20
    this.daiCollateralValue = 10

    beforeEach(async () => {
        this.livepeerToken = await TestErc20.new()
        this.daiToken = await TestErc20.new()
        const bondingManager = await BondingManagerMock.new(this.unbondingPeriodRounds)
        const roundsManager = await RoundsManagerMock.new(this.roundLengthBlocks)
        const controller = await ControllerMock.new(this.livepeerToken.address, bondingManager.address, roundsManager.address)
        this.timeLockedLptOrder = await TimeLockedLptOrder.new(controller.address, this.daiToken.address)
    })

    context('createLptSellOrder(lptSellValue, daiPaymentValue, daiCollateralValue, deliveredByBlock)', () => {

        beforeEach(async () => {
            this.deliveredByBlock = (await latestBlock()).add(new BN(20))
            await this.daiToken.approve(this.timeLockedLptOrder.address, this.daiCollateralValue)
            await this.timeLockedLptOrder.createLptSellOrder(this.lptSellValue, this.daiPaymentValue, this.daiCollateralValue, this.deliveredByBlock)
        })

        it('creates correct LPT sell order', async () => {
            const {
                lptSellValue,
                daiPaymentValue,
                daiCollateralValue,
                deliveredByBlock,
                buyerAddress
            } = await this.timeLockedLptOrder.lptSellOrders(sellOrderCreator)

            await assertEqualBN(lptSellValue, this.lptSellValue)
            await assertEqualBN(daiPaymentValue, this.daiPaymentValue)
            await assertEqualBN(daiCollateralValue, this.daiCollateralValue)
            await assertEqualBN(deliveredByBlock, this.deliveredByBlock)
            assert.strictEqual(buyerAddress, ZERO_ADDRESS)
        })

        it('reverts on creating a second LPT sell order', async () => {
            await this.daiToken.approve(this.timeLockedLptOrder.address, this.daiCollateralValue)
            await assertRevert(this.timeLockedLptOrder.createLptSellOrder(this.lptSellValue, this.daiPaymentValue,
                this.daiCollateralValue, this.deliveredByBlock), "LPT_ORDER_INITIALISED_ORDER")
        })

        context('cancelLptSellOrder()', () => {

            it('deletes the sell order', async () => {
                await this.timeLockedLptOrder.cancelLptSellOrder()

                const {
                    lptSellValue,
                    daiPaymentValue,
                    daiCollateralValue,
                    deliveredByBlock,
                    buyerAddress
                } = await this.timeLockedLptOrder.lptSellOrders(sellOrderCreator)
                await assertEqualBN(lptSellValue, 0)
                await assertEqualBN(daiPaymentValue, 0)
                await assertEqualBN(daiCollateralValue, 0)
                await assertEqualBN(deliveredByBlock, 0)
                assert.strictEqual(buyerAddress, ZERO_ADDRESS)
            })

            it('returns dai collateral', async () => {
                const originalDaiBalance = await this.daiToken.balanceOf(sellOrderCreator)
                const expectedDaiBalance = new BN(originalDaiBalance).add(new BN(this.daiCollateralValue))

                await this.timeLockedLptOrder.cancelLptSellOrder()

                const actualDaiBalance = await this.daiToken.balanceOf(sellOrderCreator)
                assert.isTrue(actualDaiBalance.eq(expectedDaiBalance))
            })

            it('can create new sell order', async () => {
                await this.timeLockedLptOrder.cancelLptSellOrder()
                await this.daiToken.approve(this.timeLockedLptOrder.address, this.daiCollateralValue)

                await this.timeLockedLptOrder.createLptSellOrder(this.lptSellValue, this.daiPaymentValue, this.daiCollateralValue, this.deliveredByBlock)

                const {
                    lptSellValue,
                    daiPaymentValue,
                    daiCollateralValue,
                    deliveredByBlock,
                    buyerAddress
                } = await this.timeLockedLptOrder.lptSellOrders(sellOrderCreator)
                await assertEqualBN(lptSellValue, this.lptSellValue)
                await assertEqualBN(daiPaymentValue, this.daiPaymentValue)
                await assertEqualBN(daiCollateralValue, this.daiCollateralValue)
                await assertEqualBN(deliveredByBlock, this.deliveredByBlock)
                assert.strictEqual(buyerAddress, ZERO_ADDRESS)
            })
        })

        context('commitToBuyLpt(address _sellOrderCreator)', () => {

            beforeEach(async () => {
                await this.daiToken.transfer(sellOrderBuyer, this.daiPaymentValue)
                await this.daiToken.approve(this.timeLockedLptOrder.address, this.daiPaymentValue, {from: sellOrderBuyer})
            })

            it('reverts when there is no sell order', async () => {
                await this.timeLockedLptOrder.cancelLptSellOrder()

                await assertRevert(this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator, {from: sellOrderBuyer}), "LPT_ORDER_UNINITIALISED_ORDER")
            })

            it('reverts when already committed too', async () => {
                await this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator, {from: sellOrderBuyer})

                await assertRevert(this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator), "LPT_ORDER_SELL_ORDER_COMMITTED_TO")
            })

            it('reverts when within unbonding period', async () => {
                await advanceToBlock(this.deliveredByBlock - 5)

                await assertRevert(this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator, {from: sellOrderBuyer}), "LPT_ORDER_COMMITMENT_WITHIN_UNBONDING_PERIOD")
            })

            it('transfers the dai to the timeLockedLptOrder contract', async () => {
                const originalDaiBalance = await this.daiToken.balanceOf(this.timeLockedLptOrder.address)
                const expectedDaiBalance = originalDaiBalance.add(new BN(this.daiPaymentValue))

                await this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator, {from: sellOrderBuyer})

                const actualDaiBalance = await this.daiToken.balanceOf(this.timeLockedLptOrder.address)
                assert.isTrue(actualDaiBalance.eq(expectedDaiBalance))
            })

            it('sets the correct buyer address on the sell order', async () => {
                await this.timeLockedLptOrder.commitToBuyLpt(sellOrderCreator, {from: sellOrderBuyer})

                const { buyerAddress } = await this.timeLockedLptOrder.lptSellOrders(sellOrderCreator)

                assert.strictEqual(buyerAddress, sellOrderBuyer)
            })
        })
    })
})