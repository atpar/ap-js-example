const { AP, Template, Order, Utils, Asset } = require('@atpar/ap.js');
const { web3,
    generateAccounts,
    getAccount,
    spinLog, 
    signTypedData, 
    sleep } = require('./utils');

const TEMPLATE_TERMS = require('./utils/templateTerms.json');
const SettlementToken = require('./utils/SettlementToken.min.json');

const creatorAccount = getAccount(0)
const creator = creatorAccount.address
const counterpartyAccount = getAccount(1)
const counterparty = counterpartyAccount.address

// Main Entry Point
const main = async () => {

    // Initialize creator ap.js
    const creatorAP = await AP.init(web3, creator);
    const counterpartyAP = await AP.init(web3, counterparty);
    // Deploy settlement token
    const settlementToken = await createSettlementToken(creator)
    const settlementTokenAddress = settlementToken.options.address

    // Create new template
    const template = await createTemplate(creatorAP, settlementTokenAddress);

    //Get Template from ID
    // const template = await getTemplate(creatorAP, "0xefd659e9865341f78f0938fe61bc92aadf66d3f91b06e5903de5f72d6d13d025");

    // Create a new Order from Template
    const order = await createAndSignOrder(creatorAP, template)

    // Sign order as counterparty
    const orderSigned = await signOrderAsCounterparty(counterpartyAP, order)
    const orderData = orderSigned.serializeOrder()

    // Load order from the orderData to verify signatures
    const verifiedOrder = await Order.load(creatorAP, orderData)
    console.log("Order has been signed and verified")

    // Issue asset from order
    // would be nice if this returned either a tx hash or an Asset object
    let sLog = spinLog("Sending Asset Issuance Transaction")
    await verifiedOrder.issueAssetFromOrder();
    sLog.stop(true)

    let assetIdList = await creatorAP.getAssetIds()
    let assetId = assetIdList.pop()
    console.log("New Asset Created: " + assetId)

    let asset = await Asset.load(creatorAP, assetId)

    // Service Asset
    const { amount, token, payer } = await asset.getNextScheduledPayment();
    const assetActorAddress = await asset.getActorAddress();

    // await asset.approveNextScheduledPayment();

    const erc20 = creatorAP.contracts.erc20(token);
    let sLog1 = spinLog("Approving AssetActor contract")
    let tx1 = await erc20.methods.approve(assetActorAddress, amount).send({ from: creator, gas: 7500000 });
    sLog1.stop(true)
    console.log("Approve Transaction: " + tx1.transactionHash)

    // hacky prevent web3 from sending tx with same nonce
    await sleep(500)

    let sLog2 = spinLog("Progressing Asset")
    try {
        const tx2 = await asset.progress();
        sLog2.stop(true)
        console.log("Asset has been serviced!")
    } catch (error) {
        sLog2.stop(true)
        console.log(error)
    }
    process.exit(0)
}

const createSettlementToken = async (account) => {
    let sLog = spinLog("Creating ERC20 Settlement Token Contract ")
    let sampleToken = new web3.eth.Contract(SettlementToken.abi);
    let token = await sampleToken.deploy({ data: SettlementToken.bytecode }).send({ from: account, gas: 2000000 });
    sLog.stop(true)
    console.log("Token Created: " + token.options.address)
    return token
}

const createTemplate = async (ap, tokenAddress) => {

    let extendedTerms = Utils.conversion.deriveExtendedTemplateTermsFromTerms(TEMPLATE_TERMS)
    extendedTerms.currency = tokenAddress
    extendedTerms.settlementCurrency = tokenAddress

    let sLog = spinLog("Sending Transaction to create new Template")
    const template = await Template.create(ap, extendedTerms);
    sLog.stop(true)
    console.log("New Template Created: " + template.templateId)

    return template
}

const getTemplate = async (ap, registeredTemplateId) => {

    const template = await Template.load(ap, registeredTemplateId);
    // console.log(template)

    const storedTemplateTerms = await template.getTemplateTerms();
    // console.log(storedTemplateTerms)

    const schedule = await template.getTemplateSchedule()
    // console.log(schedule)

    return template
}

const createAndSignOrder = async (ap, template) => {
    const dateNow = Math.round((new Date()).getTime() / 1000)

    const templateTerms = await template.getTemplateTerms();

    let updatedTerms = Object.assign({}, TEMPLATE_TERMS)

    updatedTerms.notionalPrincipal = '44200000000000000000000'
    updatedTerms.nominalInterestRate = '3530000000000000000'
    updatedTerms.contractDealDate = `${dateNow}`
    // Need to add these from extended terms so they dont get overwritten with 0x0 value address
    updatedTerms.currency = templateTerms.currency
    updatedTerms.settlementCurrency = templateTerms.settlementCurrency


    // overlay customized terms over template defaults
    const customTerms = Utils.conversion.deriveCustomTermsFromTermsAndTemplateTerms(updatedTerms, templateTerms);

    let orderParams = {
        termsHash: ap.utils.erc712.getTermsHash(updatedTerms),
        templateId: template.templateId,
        customTerms,
        ownership: {
            creatorObligor: creator,
            creatorBeneficiary: creator,
            counterpartyObligor: counterparty,
            counterpartyBeneficiary: counterparty
        },
        expirationDate: String(updatedTerms.contractDealDate),
        engine: ap.contracts.pamEngine.options.address,
        admin: Utils.constants.ZERO_ADDRESS
    }

    const order = Order.create(ap, orderParams);

    console.log("Order created!")

    const typedDataOrder = Utils.erc712.getOrderDataAsTypedData(order.orderData, false, ap.signer.verifyingContractAddress)

    // await order.signOrder();
    const sig = signTypedData(creatorAccount, typedDataOrder)
    order.orderData.creatorSignature = sig

    return order
}

const signOrderAsCounterparty = async (counterPartyAP, order) => {
    let orderData = order.serializeOrder();
    let typedDataOrder = Utils.erc712.getOrderDataAsTypedData(orderData, true, counterPartyAP.signer.verifyingContractAddress)
    let sig = signTypedData(counterpartyAccount, typedDataOrder)
    order.orderData.counterpartySignature = sig
    return order
}



main();