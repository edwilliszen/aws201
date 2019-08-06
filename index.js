const AWS = require('aws-sdk');
const translate = new AWS.Translate();
const sns = new AWS.SNS();
const doc = require('dynamodb-doc');
const dynamo = new doc.DynamoDB();
const https = require('https');

const comprehend = new AWS.Comprehend();

exports.handler = (event, context, callback) => {
    console.log(JSON.stringify(event, null, 2));
    
    var ticket = event;//JSON.parse(event); //this will hold all the ticket parameters the trigger in Zendesk passes me
    console.log(JSON.stringify(ticket, null, 2));

    // only fire for ticket created
    if (ticket.detail.ticket_event.type !== 'Comment Created' ) {
        console.log("not a comment exiting");
        return true;
    }

    if (ticket.detail.ticket_event.comment.is_public !== true ) {
        console.log("not a public comment exiting");
        return true;
    }
    
    // Force Priority since it doesn't exist
    ticket.Priority = 'Urgent';
    
    //This block of code just runs at the end to send status codes and error messages
    const done = (err, res) => callback(null, {
        statusCode: err ? '400' : '200',
        body: err ? err.message : JSON.stringify(res),
        headers: {
            'Content-Type': 'application/json',
        },
    });
    
    //Amazon Translate - runs first
    var params = {
        SourceLanguageCode: 'auto', /* required */
        TargetLanguageCode: 'en', /* required */      
        Text: ticket.detail.ticket_event.comment.body, /* required */
    };
    translate.translateText(params, function(err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else    { // successful response
            console.log(`Translation = ${JSON.stringify(data, null, 2)}`);;
            ticket.EnglishDescription = data.TranslatedText;
            ticket.sourceLanguage = data.SourceLanguageCode;
            
            //SNS - runs after translate, concurrently to DynamoDB
            if (ticket.Priority == "Urgent") {
                console.log('Sending SMS');
                var snsParams = {
                    Message: ("New Urgent Ticket! ID = " + ticket.detail.ticket_event.ticket.id + "; Description: " + ticket.EnglishDescription),
                    PhoneNumber: process.env.PHONENUMBER
                };
                console.log(snsParams);
                sns.publish(snsParams, function(err, data) {
                    if (err) console.log('SNS error', err, err.stack);
                    else console.log("message sent");
                });
            }
         

            // Now run sentiment analysis on the converted text
            const params = {
                Text: ticket.EnglishDescription
            };
            
            var sentiment_score = '';
            var sentiment_tag = '';
            // Detecting the dominant language of the text
            comprehend.detectDominantLanguage(params, function (err, result) {
                if (!err) {
                    const language = result.Languages[0].LanguageCode;
                    const sentimentParams = {
                        Text:  ticket.EnglishDescription,
                        LanguageCode: language
                    };
                    // Analyze the sentiment
                    comprehend.detectSentiment(sentimentParams, function (err, data) {
                        if (err) console.log(err, err.stack); // an error occurred
                        else {
                            console.log(`sentiment: ${JSON.stringify(data, null, 2)}`);
                            sentiment_tag = `Sentiment_${data.Sentiment}`;
                            sentiment_score = `\n\n---Sentiment score---\n${JSON.stringify(data.SentimentScore)}`;

                            //ZENDESK: Send translation back to Zendesk ticket as a comment when source language isn't English
                            if(data.SourceLanguageCode != 'en') {
                                var postData = JSON.stringify({
                                    'ticket': {
                                        'tags': [sentiment_tag],
                                        'comment': {
                                            "body": ('---English Translation of Body---\n' +  ticket.EnglishDescription) + sentiment_score,
                                            "public": false
                                        }
                                    }
                                });

                                console.log(`postData: ${postData}`);
                                
                                //Create authorization string in base64
                                let authString = (process.env.ZENDESK_USEREMAIL + '/token:' + process.env.ZENDESK_APIKEY);
                                let buff = new Buffer(authString);
                                let base64Auth = buff.toString('base64');

                                var headers = {
                                    'Content-Type': 'application/json',
                                    'Content-Length': Buffer.byteLength(postData),
                                    'Authorization' : ('Basic ' + base64Auth),
                                };
                                
                                var options = {
                                    method: 'PUT',
                                    headers: headers,
                                    host: process.env.ZENDESK_DOMAIN,
                                    path: ('/api/v2/tickets/' + ticket.detail.ticket_event.ticket.id + '.json'),
                                    body: postData
                                };

                                const req = https.request(options, (res) => {
                                    console.log('statusCode:', res.statusCode);
                                    console.log('headers:', res.headers);
                                    res.on('data', (d) => {
                                        process.stdout.write(d);
                                    });
                                });

                                req.on('error', (e) => {
                                    console.error(e);
                                });

                                //Write data to request body
                                req.write(postData);
                                req.end();
                            }
                        }
                    });                    
                }
            });
        }
    });
};