import React, { useState, useEffect } from 'react';

const Monuments = () => {
    const [monuments, setMonuments] = useState([]);

    useEffect(() => {
        fetch('/monuments')
            .then((response) => response.json())
            .then((data) => setMonuments(data))
            .catch((error) => console.error('Error:', error));
    }, []);

    return (
        <div>
            <h1>Monuments</h1>
            <table>
                <thead>
                    <tr>
                        <th>Monument</th>
                        <th>City</th>
                        <th>Country</th>
                    </tr>
                </thead>
                <tbody>
                    {monuments.map((monument, index) => (
                        <tr key={index}>
                            <td>{monument.Monument}</td>
                            <td>{monument.city}</td>
                            <td>{monument.country}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export default Monuments;
